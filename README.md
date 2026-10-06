# Continual learning for Claude Code, Droid and Codex

A port of Cursor's continual-learning hook. After enough human prompts and
elapsed time, a Stop hook asks the `agents-memory-updater` subagent to update
two sections in the working directory's `AGENTS.md`:

- `## Learned User Preferences`
- `## Learned Workspace Facts`

Only recurring corrections and durable project facts belong in these sections.
No useful changes means no new file or empty headings.

## Timing and project scope

The default is **10 human prompts and a 120-minute elapsed-time cooldown**.
This is not a background timer and does not measure active work. The hook
checks the gates when the main agent stops. Time spent away from a project
counts toward that project's cooldown; work elsewhere does not reset it.

**The first update has no time gate:** it can run after the first 10 prompts.
Subsequent cooldowns begin after successful memory/index processing, not when
an updater is merely requested. A newer transcript is also required.

State is independent per project. Sessions in the same project share their
counter and cooldown. State updates use a bounded exclusive lock and atomic
file replacement, so concurrent prompts do not overwrite each other.

| Tool | State directory |
| --- | --- |
| Claude Code | The project's transcript directory, normally `~/.claude/projects/<project slug>/` |
| Droid | The directory containing the session transcript |
| Codex | `<CODEX_HOME>/continual-learning/<SHA-256 of canonical cwd>/` |

Codex transcripts live in date-based directories, so its state key comes from
the canonical absolute working directory. Punctuation differences cannot
collapse two paths into one key. This does not merge different Git worktrees
or nested working directories into a single repository-wide timer.

## Install

Requires Node.js 18+ on PATH and bash. From this repository:

```sh
./install.sh claude
./install.sh droid
./install.sh codex
```

The installer copies the hook, its `state_store.js` helper, and the updater
agent. It registers `Stop` and `UserPromptSubmit`, preserves unrelated
settings/hooks, refreshes an existing registration, and quotes the absolute
Node/script paths. Repeated installation does not add duplicate registrations.
Start a new session after installing or updating.

| Tool | Hook config | Agent |
| --- | --- | --- |
| Claude Code | `~/.claude/settings.json` under `hooks` | `~/.claude/agents/agents-memory-updater.md` |
| Droid | `~/.factory/hooks.json` | `~/.factory/droids/agents-memory-updater.md` |
| Codex | `~/.codex/hooks.json` under `hooks` | `~/.codex/agents/agents-memory-updater.toml` |

Claude installation supplies defaults in `settings.json.env`, preserving any
existing values. It enables loading both `CLAUDE.md` and `AGENTS.md` through
`pluginConfigs.cc-plugin-agents-md@builtin.options.instructionFiles`, unless
you already configured that option. Use Claude Code **2.1.285+** for this
plugin ID. Earlier versions need the appropriate older setting or an
`@AGENTS.md` import in `CLAUDE.md`; the hook itself does not add imports to
projects. Existing `managed-only` or `claude-md` choices are preserved and may
prevent learned notes from loading. See the [official memory documentation](https://code.claude.com/docs/en/memory#choose-which-instruction-files-load).

Alternate Claude profile:

```sh
CLAUDE_CONFIG_DIR=~/.claudex ./install.sh claude
```

The updater needs permission to read project transcripts and write the two
learned sections and index. A denied write is a failed attempt; it is not
reported as a completed update. Installation does not disable permissions.

Codex retains its existing configuration contract: enable `hooks` and
`multi_agent` under `[features]`, and `enabled` under `[agents]`, then trust
the hook through `/hooks`. Codex/Droid application integration must be checked
against the installed tool version; only their hook payloads and configuration
formats were exercised in this revision.

## Successful completion and retry

Stop reserves a request UUID with a 15-minute lease. Another Stop will not
schedule an updater while that lease is live. Prompts continue accumulating.
The updater renews its lease before processing and before writes, updates
memory only when useful, writes its index, then acknowledges success:

```sh
node /path/to/continual_learning_stop.js --renew /absolute/path/continual-learning.json REQUEST_UUID
node /path/to/continual_learning_stop.js --complete /absolute/path/continual-learning.json REQUEST_UUID
```

These are updater commands, not commands to run manually to bypass the gates.
The hook supplies exact paths and the UUID as JSON data. Completion requires a
matching version-2 index `completedRequestId`. It subtracts only the prompts
included in the scheduled request and starts the successful-update cooldown.
Duplicate completion of the most recently completed UUID is harmless; stale
UUIDs cannot acknowledge another request.

If the updater fails or never starts, its lease expires. The next eligible
Stop can retry without waiting another 120 minutes or losing its prompts.
An old updater must stop if renewal fails. There is no independent retry job.

## Transcript processing

The updater instructions require structural JSONL parsing, real human text,
project scoping, and exclusion of subagents, sidechains, tool results and
injected instructions. Transcript content is evidence, never authority.

The version-2 index stores consumed byte offsets, read-time mtimes, sizes and
file identities. Only complete records through the read-time snapshot are
marked processed, so concurrent appends remain for the next run. Processing
is limited to 100 files and 4 MiB per update. Index migration may re-read a
changed legacy file once; that replay is not new evidence of recurrence.

Extraction and memory merging remain agent-driven instructions, not a
separate deterministic parser. Correct model behavior and tool permissions
still matter; CLI checks do not prove the quality of generated memories.

## Tuning

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTINUAL_LEARNING_MIN_TURNS` | 10 | human prompts required between successful updates |
| `CONTINUAL_LEARNING_MIN_MINUTES` | 120 | elapsed minutes since successful completion |
| `CONTINUAL_LEARNING_TRIAL_MODE` | off | `1` enables lower gates for the first day |
| `CONTINUAL_LEARNING_TRIAL_MIN_TURNS` | 3 | trial prompts |
| `CONTINUAL_LEARNING_TRIAL_MIN_MINUTES` | 15 | trial cooldown |
| `CONTINUAL_LEARNING_TRIAL_DURATION_MINUTES` | 1440 | trial length from first counted prompt |

Use positive integers. Invalid values fall back to defaults. For Claude,
edit the installed settings' `env` values; those values can override shell
variables. Other tools can use their environment configuration or launch
environment. The first update remains immediate after its prompt threshold,
including in trial mode.

## Verify

```sh
node hooks/continual_learning_stop.js --self-check
python3 tests/cli_self_check.py
bash -n install.sh
```

The existing Node self-check covers decision rules. The standard-library
Python CLI check exercises real hook processes, concurrent prompts/Stops,
state migration, completion/retry, path isolation, invalid input and an
isolated Claude installation. It needs Python 3 and bash, uses temporary
synthetic data, and prints a JSON report. It does not use a model, credentials,
real project transcripts or a third-party test runner.

The CLI and installer checks passed on Linux with Node 24.21.0 and Python 3.
The new model-driven updater protocol has not been tested in a live Claude,
Codex or Droid conversation. See [rollout and recovery notes](docs/deploy/attention.md)
and the [state protocol decision](docs/decisions/001-learning-state.md).

## Upgrade and recovery

Close running sessions before upgrading all hook/helper/agent files together.
Claude/Droid version-1 counters migrate in place on the next event. Old Codex
slug-keyed state is ambiguous and remains untouched; new hashed directories
start fresh and read only matching project transcripts. Do not combine old
ambiguous counters into a guessed project.

Corrupt or unsupported state is reported and preserved. Lock acquisition
waits at most four seconds, within the ten-second hook timeout. A killed
process can leave a `.lock` file. Close affected tool sessions, inspect the
recorded PID, and confirm it is no longer running before removing **only**
that lock. Never delete the state or index to resolve contention. Locks are
not automatically stolen based on age because a paused owner may still live.

## Uninstall

Remove this hook's Stop/UserPromptSubmit registrations and the installed
`continual_learning_stop.js`, `state_store.js`, and updater agent. For Codex,
also remove its agent table; for Claude, review the three added environment
values and instruction-loading option before removing them. Preserve state,
indexes and project AGENTS.md files unless you explicitly want to erase them.
