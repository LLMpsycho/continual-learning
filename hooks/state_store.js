"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");

function readJson(file) {
  if (fs.statSync(file).size > 4 * 1024 * 1024) throw new Error("JSON file exceeds the 4 MiB state/index limit");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error("Invalid JSON; existing data was preserved");
    throw error;
  }
}

function initialState() {
  return { version: 2, lastRunAtMs: 0, turnsSinceLastRun: 0,
    lastTranscriptMtimeMs: null, trialStartedAtMs: null, pending: null, lastCompletedId: null };
}

function loadState(file) {
  let value;
  try { value = readJson(file); }
  catch (error) { if (error.code === "ENOENT") return initialState(); throw error; }
  if (!value || ![1, 2].includes(value.version)) throw new Error("Unsupported state version; existing data was preserved");
  for (const field of ["lastRunAtMs", "turnsSinceLastRun", "lastTranscriptMtimeMs", "trialStartedAtMs"]) {
    const number = value[field];
    if (number !== null && (typeof number !== "number" || !Number.isFinite(number) || number < 0)) {
      throw new Error("Invalid state fields; existing data was preserved");
    }
  }
  if (!Number.isSafeInteger(value.turnsSinceLastRun) || value.lastRunAtMs === null) {
    throw new Error("Invalid state counters; existing data was preserved");
  }
  const state = { ...initialState(), ...value, version: 2 };
  if (state.pending !== null) {
    const p = state.pending;
    if (!p || typeof p.id !== "string" || !Number.isFinite(p.expiresAtMs) ||
        !Number.isSafeInteger(p.turns) || p.turns < 0 || !Number.isFinite(p.transcriptMtimeMs)) {
      throw new Error("Invalid pending update; existing data was preserved");
    }
  }
  return state;
}

function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

// The entire read/modify/write transaction is serialized, not just the write.
// Never steal a lock: even an old holder may still be alive on a paused machine.
async function withState(file, action) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = performance.now() + 4000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (performance.now() >= deadline) throw new Error("State lock timed out; close sessions and inspect the lock before recovery");
      await new Promise(resolve => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)));
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAtMs: Date.now() }));
    const state = loadState(file);
    const result = action(state);
    atomicWrite(file, state);
    return result;
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

module.exports = { initialState, readJson, withState };
