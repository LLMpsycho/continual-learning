# Continual-learning state update

## Before installation

- Close Claude/Droid/Codex sessions before replacing hook files. Back up the
  installed hook, updater agent, hook configuration, and existing
  `continual-learning.json` / `continual-learning-index.json` files.
- Requires Node.js 18+. The Claude instruction-loading default uses the
  built-in plugin ID supported in Claude Code 2.1.285 and later.
- Run `./install.sh <tool>` from the complete source tree. The new
  `hooks/state_store.js` helper must accompany the hook.
- Existing environment overrides and unrelated settings are preserved.
  Claude receives defaults for `CONTINUAL_LEARNING_MIN_TURNS`,
  `CONTINUAL_LEARNING_MIN_MINUTES`, and `CONTINUAL_LEARNING_TRIAL_MODE` only
  when absent. Explicit instruction-loading preferences are preserved.

## Data and rollout

- Claude/Droid version-1 state migrates to version 2 on the next event.
  Existing counters and timestamps are preserved; a timestamp recorded by
  the old hook cannot retrospectively prove updater success.
- Codex starts separate SHA-256-keyed state directories. Old ambiguous
  slug directories and their indexes remain unchanged for inspection.
- The updater migrates the mtime index to byte offsets. Changed legacy files
  may be re-read once and must not count as new recurring evidence.
- No project memory is processed during installation. A new session and
  normal prompt/Stop gates start the flow. Successful index writes now need
  a completion acknowledgement. No extra service, database, domain, webhook,
  backfill, or background worker is introduced.

## Verification and monitoring

Run:

```sh
node hooks/continual_learning_stop.js --self-check
python3 tests/cli_self_check.py
bash -n install.sh
```

The CLI checks use synthetic temporary projects and require no model or
credentials. They exercise installed commands, 48 concurrent prompts,
24 concurrent Stops, completion, stale requests, retries, corrupt state,
project isolation and repeated installation with quoted paths.

Observe the first real updater cycle in a new session: memory/index writes
should succeed, `pending` should become null, and `lastRunAtMs` should advance
only after acknowledgement. The new model-driven protocol has not been
verified in a live tool conversation. Do not infer model correctness from the
CLI checks or label permission-denied writes as successful updates.

Failures are reported without transcript content or stack traces. If a lock
times out, inspect the `.lock` file's PID after closing affected sessions.
Confirm the holder is dead before removing only that lock; leave counters,
indexes, and memory intact. Do not steal a live or merely old lock.

## Rollback

Close sessions. Restore the backed-up hook, agent, configuration and matching
version-1 state/index together. Do not run the old hook against version-2
state: its fallback reader would silently reset counters. If no backup
exists, retain the version-2 files and disable the hook while investigating;
do not delete them. Any restoration must preserve subsequent user edits and
requires the operator's approval. AGENTS.md memory does not need rollback
merely because the hook implementation changes.
