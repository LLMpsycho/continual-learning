# Continual learning for Claude Code, Droid and Codex

A port of Cursor's `continual-learning` plugin. Every few turns, a Stop hook
asks the agent to run the `agents-memory-updater` subagent, which mines the
session transcripts written since the last run and keeps two bullet lists in
the project's `AGENTS.md` up to date:

```
## Learned User Preferences
## Learned Workspace Facts
```

All three tools read `AGENTS.md` from the working directory, so the learned
facts follow the project, not the tool.

## How it works

- `UserPromptSubmit` counts your prompts. Synthetic prompts from background
  subagents are ignored.
- `Stop` checks four gates: enough prompts since the last run, enough minutes
  since the last run, the transcript has grown, and this stop is not itself a
  hook continuation. When all pass it returns `decision: block` with the
  follow-up instruction, and the agent runs the updater before finishing.
- The updater reads only transcripts that are new or changed versus an index
  file, updates `AGENTS.md`, and rewrites the index.

State and index files live next to the transcripts, one folder per project,
so nothing is written into your repositories:

| Tool | State and index location |
| --- | --- |
| Claude Code | `~/.claude/projects/<project slug>/continual-learning*.json` |
| Droid | the folder that holds the session transcript |
| Codex | `~/.codex/continual-learning/<cwd slug>/continual-learning*.json` |

## Install

Requires Node.js on the PATH. Run one of:

```
./install.sh claude
./install.sh droid
./install.sh codex
```

The script copies two files and appends the hook to the tool's hook config.
It never removes existing hooks. Run it once per tool.

| Tool | Hook script | Agent | Hook config |
| --- | --- | --- | --- |
| Claude Code | `~/.claude/hooks/continual_learning_stop.js` | `~/.claude/agents/agents-memory-updater.md` | `~/.claude/settings.json` under `hooks` |
| Droid | `~/.factory/hooks/continual_learning_stop.js` | `~/.factory/droids/agents-memory-updater.md` | `~/.factory/hooks.json` |
| Codex | `~/.codex/hooks/continual_learning_stop.js` | `~/.codex/agents/agents-memory-updater.toml` | `~/.codex/hooks.json` and `[agents.agents-memory-updater]` in `config.toml` |

Codex extras: `config.toml` needs `hooks = true` and `multi_agent = true`
under `[features]` and `enabled = true` under `[agents]`. Codex also refuses
to run a hook until you trust it, so start `codex` and run `/hooks` once.

Claude Code note: the index sits under `~/.claude`, which Claude Code treats
as a sensitive folder. With `--dangerously-skip-permissions` or auto mode it
is written silently. In stricter permission modes the updater will ask before
writing it. If you decline, `AGENTS.md` is still updated; the next run just
re-reads all transcripts.

Using a second Claude Code profile through `CLAUDE_CONFIG_DIR`? Run
`CLAUDE_CONFIG_DIR=~/.claudex ./install.sh claude`.

## Tuning

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CONTINUAL_LEARNING_MIN_TURNS` | 10 | prompts required between runs |
| `CONTINUAL_LEARNING_MIN_MINUTES` | 120 | minutes required between runs |
| `CONTINUAL_LEARNING_TRIAL_MODE` | off | `1` lowers the gates for the first day |
| `CONTINUAL_LEARNING_TRIAL_MIN_TURNS` | 3 | trial-mode prompts |
| `CONTINUAL_LEARNING_TRIAL_MIN_MINUTES` | 15 | trial-mode minutes |
| `CONTINUAL_LEARNING_TRIAL_DURATION_MINUTES` | 1440 | trial length |

Set them in the tool's `env` settings or your shell before launching.

## Check it

```
node ~/.claude/hooks/continual_learning_stop.js --self-check
```

To see one full cycle immediately, start a session with the gates lowered:

```
CONTINUAL_LEARNING_MIN_TURNS=1 CONTINUAL_LEARNING_MIN_MINUTES=1 claude
```

Send one prompt, wait for the reply, and the updater runs before the turn
ends. Then look at `AGENTS.md` in that directory and the state file for the
project.

## Verification status

- Claude Code: tested end to end on macOS and Linux, including the full
  updater cycle and both the plain and `CLAUDE_CONFIG_DIR` profiles.
- Codex: tested end to end with `codex exec` in an isolated `CODEX_HOME`,
  including the subagent run, `AGENTS.md` update and index write.
- Droid: written against the Factory hooks and custom-droid docs, not run.
  The hook input has no `hook_event_name`, so prompts are detected by the
  `prompt` field. If Droid rejects the plain `decision: block` output, wrap
  it as documented in Factory's hooks reference.

## Uninstall

Delete the two copied files and remove the two entries whose command
contains `continual_learning_stop` from the hook config. For Codex also
remove the `[agents.agents-memory-updater]` table from `config.toml`.
