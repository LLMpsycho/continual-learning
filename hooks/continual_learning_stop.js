#!/usr/bin/env node
// Continual-learning hook for Claude Code, Factory Droid and Codex.
// Port of Cursor's continual-learning Stop hook.
//
// UserPromptSubmit counts human turns; Stop decides. After enough turns and
// elapsed time, Stop blocks once with a follow-up instruction that runs the
// `agents-memory-updater` subagent, which updates AGENTS.md in the working
// directory. Turns are not counted on Stop because a background subagent's
// completion notification wakes the main agent for an extra turn.
//
// State lives beside the transcripts (Claude Code, Droid: one directory per
// project) or under <CODEX_HOME>/continual-learning/<cwd slug>/ for Codex,
// whose transcripts are stored by date rather than by project.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = { minTurns: 10, minMinutes: 120 };
const TRIAL_DEFAULTS = { minTurns: 3, minMinutes: 15, durationMinutes: 24 * 60 };

function positiveInt(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

function loadState(statePath) {
  const fallback = { version: 1, lastRunAtMs: 0, turnsSinceLastRun: 0, lastTranscriptMtimeMs: null, trialStartedAtMs: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed.version !== 1) return fallback;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return {
      version: 1,
      lastRunAtMs: num(parsed.lastRunAtMs) ?? 0,
      turnsSinceLastRun: Math.max(0, num(parsed.turnsSinceLastRun) ?? 0),
      lastTranscriptMtimeMs: num(parsed.lastTranscriptMtimeMs),
      trialStartedAtMs: num(parsed.trialStartedAtMs),
    };
  } catch {
    return fallback;
  }
}

// Pure decision: event is "prompt" (count a human turn) or "stop" (evaluate the
// gates without counting). Returns the next state and whether to trigger.
function decide(state, { event, transcriptMtimeMs, env, now }) {
  const countedTurn = event === "prompt";
  const next = { ...state };
  const trialEnabled = truthy(env.CONTINUAL_LEARNING_TRIAL_MODE);
  if (trialEnabled && countedTurn && next.trialStartedAtMs === null) next.trialStartedAtMs = now;
  const inTrial =
    trialEnabled &&
    next.trialStartedAtMs !== null &&
    now - next.trialStartedAtMs < positiveInt(env.CONTINUAL_LEARNING_TRIAL_DURATION_MINUTES, TRIAL_DEFAULTS.durationMinutes) * 60_000;
  const minTurns = inTrial
    ? positiveInt(env.CONTINUAL_LEARNING_TRIAL_MIN_TURNS, TRIAL_DEFAULTS.minTurns)
    : positiveInt(env.CONTINUAL_LEARNING_MIN_TURNS, DEFAULTS.minTurns);
  const minMinutes = inTrial
    ? positiveInt(env.CONTINUAL_LEARNING_TRIAL_MIN_MINUTES, TRIAL_DEFAULTS.minMinutes)
    : positiveInt(env.CONTINUAL_LEARNING_MIN_MINUTES, DEFAULTS.minMinutes);

  const turns = next.turnsSinceLastRun + (countedTurn ? 1 : 0);
  const minutesSince = next.lastRunAtMs > 0 ? Math.floor((now - next.lastRunAtMs) / 60_000) : Infinity;
  const advanced =
    transcriptMtimeMs !== null && (next.lastTranscriptMtimeMs === null || transcriptMtimeMs > next.lastTranscriptMtimeMs);
  const trigger = event === "stop" && turns >= minTurns && minutesSince >= minMinutes && advanced;

  if (trigger) {
    next.lastRunAtMs = now;
    next.turnsSinceLastRun = 0;
    next.lastTranscriptMtimeMs = transcriptMtimeMs;
  } else {
    next.turnsSinceLastRun = turns;
  }
  return { next, trigger };
}

// Background subagent completions arrive as synthetic prompts; they are not human turns.
function isSyntheticPrompt(prompt) {
  return typeof prompt === "string" && prompt.trimStart().startsWith("<task-notification>");
}

// Where state lives and which transcripts the updater should read.
function resolveLayout(transcriptPath, cwd) {
  const codexMatch = transcriptPath.match(/^(.*)[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/][^\\/]+\.jsonl$/);
  if (codexMatch) {
    const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
    return {
      stateDir: path.join(codexMatch[1], "continual-learning", slug),
      transcriptDir: path.join(codexMatch[1], "sessions"),
      scope: `Only consider sessions whose first line (session_meta) has cwd equal to \`${cwd}\`. `,
    };
  }
  const dir = path.dirname(transcriptPath);
  return { stateDir: dir, transcriptDir: dir, scope: "" };
}

function followupMessage({ transcriptDir, indexPath, agentsPath, scope }) {
  return (
    "Run the `agents-memory-updater` subagent now for the full continual-learning memory update flow. " +
    `Transcripts: \`${transcriptDir}\` (all *.jsonl files, recursively; ignore memory/ and tool-results/). ${scope}` +
    `Use incremental transcript processing with index file \`${indexPath}\`: only consider transcripts not in the index or whose mtime is newer than the indexed mtime. ` +
    `Have the subagent refresh index mtimes, remove entries for deleted transcripts, and update \`${agentsPath}\` only for high-signal recurring user corrections and durable workspace facts. ` +
    "Exclude one-off/transient details and secrets. If no meaningful updates exist, respond exactly: No high-signal memory updates."
  );
}

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  // Droid omits hook_event_name, so a prompt field also identifies a prompt event.
  const event = input.hook_event_name === "UserPromptSubmit" || typeof input.prompt === "string" ? "prompt" : "stop";
  if (event === "prompt" && isSyntheticPrompt(input.prompt)) return {};
  if (input.stop_hook_active || !input.transcript_path) return {};
  const cwd = input.cwd || process.cwd();
  const { stateDir, transcriptDir, scope } = resolveLayout(input.transcript_path, cwd);
  const statePath = path.join(stateDir, "continual-learning.json");
  let transcriptMtimeMs = null;
  try {
    transcriptMtimeMs = fs.statSync(input.transcript_path).mtimeMs;
  } catch {}
  const { next, trigger } = decide(loadState(statePath), {
    event,
    transcriptMtimeMs,
    env: process.env,
    now: Date.now(),
  });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`);
  if (!trigger) return {};
  return {
    decision: "block",
    reason: followupMessage({
      transcriptDir,
      indexPath: path.join(stateDir, "continual-learning-index.json"),
      agentsPath: path.join(cwd, "AGENTS.md"),
      scope,
    }),
  };
}

function selfCheck() {
  const assert = require("node:assert/strict");
  const base = { version: 1, lastRunAtMs: 0, turnsSinceLastRun: 0, lastTranscriptMtimeMs: null, trialStartedAtMs: null };
  const now = 1_000_000_000;
  const on = (state, event, extra = {}) => decide(state, { event, transcriptMtimeMs: 5, env: {}, now, ...extra });
  // A prompt counts a turn and never triggers.
  let r = on({ ...base, turnsSinceLastRun: 9 }, "prompt");
  assert.equal(r.trigger, false);
  assert.equal(r.next.turnsSinceLastRun, 10);
  // A stop below the threshold neither counts nor triggers.
  r = on({ ...base, turnsSinceLastRun: 9 }, "stop");
  assert.equal(r.trigger, false);
  assert.equal(r.next.turnsSinceLastRun, 9);
  // A stop at the threshold on first run triggers and resets.
  r = on({ ...base, turnsSinceLastRun: 10 }, "stop");
  assert.equal(r.trigger, true);
  assert.equal(r.next.turnsSinceLastRun, 0);
  assert.equal(r.next.lastRunAtMs, now);
  // Too soon since the last run: no trigger.
  r = on({ ...base, turnsSinceLastRun: 10, lastRunAtMs: now - 60_000 }, "stop");
  assert.equal(r.trigger, false);
  // Transcript has not advanced: no trigger.
  r = on({ ...base, turnsSinceLastRun: 10, lastTranscriptMtimeMs: 5 }, "stop");
  assert.equal(r.trigger, false);
  // Trial mode: the first prompt starts the trial clock, then 3 turns suffice.
  const trialEnv = { env: { CONTINUAL_LEARNING_TRIAL_MODE: "1" } };
  r = on({ ...base, turnsSinceLastRun: 2 }, "prompt", trialEnv);
  assert.equal(r.next.trialStartedAtMs, now);
  r = on(r.next, "stop", trialEnv);
  assert.equal(r.trigger, true);
  // Task notifications are synthetic prompts, real prompts are not.
  assert.equal(isSyntheticPrompt("<task-notification>\n<task-id>x</task-id>"), true);
  assert.equal(isSyntheticPrompt("Reply with OK"), false);
  // Layout: per-project directory for Claude Code and Droid, cwd slug under CODEX_HOME for Codex.
  let l = resolveLayout("/home/u/.claude/projects/-home-u-app/abc.jsonl", "/home/u/app");
  assert.equal(l.stateDir, "/home/u/.claude/projects/-home-u-app");
  assert.equal(l.transcriptDir, l.stateDir);
  l = resolveLayout("/home/u/.codex/sessions/2026/09/22/rollout-x.jsonl", "/home/u/app");
  assert.equal(l.stateDir, "/home/u/.codex/continual-learning/-home-u-app");
  assert.equal(l.transcriptDir, "/home/u/.codex/sessions");
  assert.ok(l.scope.includes("/home/u/app"));
  console.log("continual_learning_stop self-check passed");
}

if (require.main === module) {
  if (process.argv.includes("--self-check")) {
    selfCheck();
  } else {
    let output = {};
    try {
      output = main();
    } catch (error) {
      console.error("[continual_learning_stop] failed", error);
    }
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
}
