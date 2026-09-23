#!/usr/bin/env bash
# Install the continual-learning hook and updater agent into one tool's config.
# Usage: ./install.sh claude|droid|codex
# Requires: node (the hook runs on Node), bash.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tool="${1:-}"
[[ -n "$tool" ]] || { echo "usage: $0 claude|droid|codex" >&2; exit 2; }
command -v node >/dev/null || { echo "node is required" >&2; exit 1; }

# merge_hooks <json file> <wrapped: yes|no> <hook script path>
# Appends the hook to the Stop and UserPromptSubmit arrays, skipping if present.
merge_hooks() {
  node - "$1" "$2" "$3" <<'JS'
const fs = require("node:fs");
const [file, wrapped, script] = process.argv.slice(2);
let root = {};
if (fs.existsSync(file)) root = JSON.parse(fs.readFileSync(file, "utf8"));
const hooks = wrapped === "yes" ? (root.hooks ??= {}) : root;
const entry = { hooks: [{ type: "command", command: `node "${script}"`, timeout: 10 }] };
for (const event of ["Stop", "UserPromptSubmit"]) {
  const list = (hooks[event] ??= []);
  const present = list.some((m) => (m.hooks ?? []).some((h) => String(h.command).includes("continual_learning_stop")));
  if (!present) list.push(entry);
}
fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`);
console.log(`hooks registered in ${file}`);
JS
}

case "$tool" in
  claude)
    dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
    mkdir -p "$dir/hooks" "$dir/agents"
    cp "$here/hooks/continual_learning_stop.js" "$dir/hooks/"
    cp "$here/agents/agents-memory-updater.md" "$dir/agents/"
    merge_hooks "$dir/settings.json" yes "$dir/hooks/continual_learning_stop.js"
    ;;
  droid)
    dir="$HOME/.factory"
    mkdir -p "$dir/hooks" "$dir/droids"
    cp "$here/hooks/continual_learning_stop.js" "$dir/hooks/"
    cp "$here/agents/agents-memory-updater.md" "$dir/droids/"
    merge_hooks "$dir/hooks.json" no "$dir/hooks/continual_learning_stop.js"
    ;;
  codex)
    dir="${CODEX_HOME:-$HOME/.codex}"
    mkdir -p "$dir/hooks" "$dir/agents"
    cp "$here/hooks/continual_learning_stop.js" "$dir/hooks/"
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
