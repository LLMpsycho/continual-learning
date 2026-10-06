#!/usr/bin/env bash
# Install the continual-learning hook and updater agent into one tool's config.
# Usage: ./install.sh claude|droid|codex
# Requires: node (the hook runs on Node), bash.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tool="${1:-}"
if [[ "$tool" == "--help" || "$tool" == "-h" ]]; then
  echo "usage: $0 claude|droid|codex"
  exit 0
fi
[[ -n "$tool" ]] || { echo "usage: $0 claude|droid|codex" >&2; exit 2; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 18) { console.error("Node.js 18+ is required"); process.exit(1); }'

# merge_hooks <json file> <wrapped: yes|no> <hook script path>
# Updates our registration and preserves unrelated hooks and settings.
merge_hooks() {
  node - "$1" "$2" "$3" "$tool" <<'JS'
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const [file, wrapped, script, tool] = process.argv.slice(2);
let root = {};
if (fs.existsSync(file)) root = JSON.parse(fs.readFileSync(file, "utf8"));
if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error("Expected a settings object");
const hooks = wrapped === "yes" ? (root.hooks ??= {}) : root;
const quote = value => "'" + value.replace(/'/g, "'\\''") + "'";
const command = `${quote(process.execPath)} ${quote(script)}`;
for (const event of ["Stop", "UserPromptSubmit"]) {
  const list = (hooks[event] ??= []);
  let present = false;
  for (const group of list) {
    for (const hook of group.hooks ?? []) {
      const old = String(hook.command ?? "");
      if (hook.type === "command" && (old === command ||
          (/^(?:node|\S*\/node|'[^']*\/node'|"[^"]*\/node")\s/.test(old) &&
           /continual_learning_stop\.js["']?$/.test(old)))) {
        hook.command = command;
        hook.timeout = 10;
        present = true;
      }
    }
  }
  if (!present) list.push({ hooks: [{ type: "command", command, timeout: 10 }] });
}
if (tool === "claude") {
  const env = (root.env ??= {});
  env.CONTINUAL_LEARNING_MIN_TURNS ??= "10";
  env.CONTINUAL_LEARNING_MIN_MINUTES ??= "120";
  env.CONTINUAL_LEARNING_TRIAL_MODE ??= "0";
  const plugin = ((root.pluginConfigs ??= {})["cc-plugin-agents-md@builtin"] ??= {});
  (plugin.options ??= {}).instructionFiles ??= "claude-md-and-agents-md";
}
const temporary = `${file}.${randomUUID()}.tmp`;
try {
  fs.writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, {
    flag: "wx", mode: fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600,
  });
  fs.renameSync(temporary, file);
} finally {
  try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
console.log(`hooks registered in ${file}`);
JS
}

case "$tool" in
  claude)
    dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    mkdir -p "$dir/hooks" "$dir/agents"
    dir="$(cd "$dir" && pwd)"
    cp "$here/hooks/continual_learning_stop.js" "$dir/hooks/"
    cp "$here/hooks/state_store.js" "$dir/hooks/"
    cp "$here/agents/agents-memory-updater.md" "$dir/agents/"
    merge_hooks "$dir/settings.json" yes "$dir/hooks/continual_learning_stop.js"
    ;;
  droid)
    dir="$HOME/.factory"
    mkdir -p "$dir/hooks" "$dir/droids"
    cp "$here/hooks/continual_learning_stop.js" "$dir/hooks/"
    cp "$here/hooks/state_store.js" "$dir/hooks/"
    cp "$here/agents/agents-memory-updater.md" "$dir/droids/"
    merge_hooks "$dir/hooks.json" no "$dir/hooks/continual_learning_stop.js"
    ;;
  codex)
    dir="${CODEX_HOME:-$HOME/.codex}"
    mkdir -p "$dir/hooks" "$dir/agents"
    dir="$(cd "$dir" && pwd)"
    cp "$here/hooks/continual_learning_stop.js" "$dir/hooks/"
    cp "$here/hooks/state_store.js" "$dir/hooks/"
    cp "$here/agents/codex/agents-memory-updater.toml" "$dir/agents/"
    merge_hooks "$dir/hooks.json" yes "$dir/hooks/continual_learning_stop.js"
    if ! grep -q '^\[agents\.agents-memory-updater\]' "$dir/config.toml" 2>/dev/null; then
      printf '\n[agents.agents-memory-updater]\ncommand = "code"\nconfig_file = "%s"\ndescription = "Continual-learning memory updater for AGENTS.md"\n' \
        "$dir/agents/agents-memory-updater.toml" >> "$dir/config.toml"
      echo "agent registered in $dir/config.toml"
    fi
    cat <<MSG
Codex needs these in $dir/config.toml (add them if missing):
  [features]
  hooks = true
  multi_agent = true
  [agents]
  enabled = true
Then start codex and run /hooks to trust the new hook.
MSG
    ;;
  *) echo "unknown tool: $tool (use claude, droid or codex)" >&2; exit 2 ;;
esac
chmod +x "$dir/hooks/continual_learning_stop.js"
node "$dir/hooks/continual_learning_stop.js" --self-check
echo "installed for $tool"
