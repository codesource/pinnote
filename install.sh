#!/usr/bin/env bash
# Install (or remove with --uninstall) the Pinnote native host, the `pinnote`
# command and the Claude Code skill for the current user. The Chrome extension
# itself is loaded once by hand: chrome://extensions > Developer mode >
# Load unpacked > <this repo>/extension
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="ch.codesource.pinnote"
HOST_BIN="$ROOT/python/bin/pinnote-host"
CLI_BIN="$ROOT/python/bin/pinnote"
CLI_LINK="$HOME/.local/bin/pinnote"
SKILL_LINK="$HOME/.claude/skills/pinnote"
BROWSER_DIRS=(
  "$HOME/.config/google-chrome"
  "$HOME/.config/google-chrome-beta"
  "$HOME/.config/google-chrome-unstable"
  "$HOME/.config/chromium"
)

extension_id() {
  python3 -I - "$ROOT/extension/manifest.json" <<'PY'
import base64, hashlib, json, sys
key = json.load(open(sys.argv[1]))["key"]
digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
print("".join(chr(ord("a") + int(c, 16)) for c in digest))
PY
}

remove_link() {
  # Only remove what this script created: a symlink pointing into this repo.
  local link="$1"
  if [[ -L "$link" && "$(readlink "$link")" == "$ROOT"/* ]]; then
    rm "$link"
    echo "removed $link"
  fi
}

if [[ "${1:-}" == "--uninstall" ]]; then
  for dir in "${BROWSER_DIRS[@]}"; do
    manifest="$dir/NativeMessagingHosts/$HOST_NAME.json"
    if [[ -f "$manifest" ]]; then
      rm "$manifest"
      echo "removed $manifest"
    fi
  done
  remove_link "$CLI_LINK"
  remove_link "$SKILL_LINK"
  echo "Notes in your projects (.pinnote/) and ~/.config/pinnote are kept."
  exit 0
fi

ext_id="$(extension_id)"
chmod +x "$HOST_BIN" "$CLI_BIN"

installed=0
for dir in "${BROWSER_DIRS[@]}"; do
  [[ -d "$dir" ]] || continue
  mkdir -p "$dir/NativeMessagingHosts"
  python3 -I - "$dir/NativeMessagingHosts/$HOST_NAME.json" "$HOST_BIN" "$ext_id" <<'PY'
import json, sys
target, host_bin, ext_id = sys.argv[1:4]
manifest = {
    "name": "ch.codesource.pinnote",
    "description": "Pinnote: stores notes pinned on dev-site elements in project folders",
    "path": host_bin,
    "type": "stdio",
    "allowed_origins": [f"chrome-extension://{ext_id}/"],
}
with open(target, "w") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
PY
  echo "native host registered for $(basename "$dir")"
  installed=1
done
if [[ $installed -eq 0 ]]; then
  echo "No Chrome or Chromium profile folder found under ~/.config; start the browser once, then rerun." >&2
  exit 1
fi

mkdir -p "$(dirname "$CLI_LINK")" "$(dirname "$SKILL_LINK")"
ln -sfn "$CLI_BIN" "$CLI_LINK"
echo "command: $CLI_LINK"
if [[ -e "$SKILL_LINK" && ! -L "$SKILL_LINK" ]]; then
  echo "skipped the skill: $SKILL_LINK exists and is not a symlink" >&2
else
  ln -sfn "$ROOT/skill" "$SKILL_LINK"
  echo "Claude Code skill: $SKILL_LINK"
fi

cat <<EOF

Next steps:
  1. Chrome: chrome://extensions > enable Developer mode > Load unpacked > $ROOT/extension
     (extension id: $ext_id)
  2. Open your dev site, click the Pinnote icon, enter the project folder, Link.
  3. Pin notes with Alt+Shift+N or right-click > "Pin a note on this element".
  4. In Claude Code, in that project: /pinnote (or /pinnote watch).
EOF
