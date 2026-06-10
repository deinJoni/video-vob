#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-}"
ADAPTER="${2:-claude-code}"

# Resolve the directory this script lives in so it works regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -z "$TARGET" ]]; then
  echo "usage: ./install.sh <target_project_dir> [adapter]"
  echo "  adapter defaults to 'claude-code'."
  echo "  available adapters:"
  for d in "$SCRIPT_DIR/adapters/"*/; do
    name="$(basename "$d")"
    echo "    - $name"
  done
  exit 1
fi

if [[ ! -d "$SCRIPT_DIR/adapters/$ADAPTER" ]]; then
  echo "unknown adapter: $ADAPTER (looked in $SCRIPT_DIR/adapters/)"
  exit 1
fi

mkdir -p "$TARGET"

# The engine is adapter-agnostic and shared by every adapter.
cp -R "$SCRIPT_DIR/mcp" "$TARGET/"

# Back up any pre-existing CLI config the wholesale copy would clobber.
for f in opencode.json .mcp.json .claude/settings.json; do
  if [[ -e "$TARGET/$f" ]]; then
    cp -R "$TARGET/$f" "$TARGET/$f.pre-vob.bak"
    echo "warning: $f existed in target — backed up to $f.pre-vob.bak (then overwritten)"
  fi
done

# Copy the adapter's config wholesale. Each adapter directory contains exactly
# the files that CLI expects, in that CLI's own layout — claude-code ships
# `.claude/` + `.mcp.json`; opencode ships `.opencode/` + `opencode.json`. The
# trailing `/.` copies all contents (including dotfiles) into the target, so
# install.sh never has to hardcode a single CLI's filenames.
cp -R "$SCRIPT_DIR/adapters/$ADAPTER/." "$TARGET/"

# Shared, adapter-independent runtime config.
cp -R "$SCRIPT_DIR/.vob" "$TARGET/"
cp -R "$SCRIPT_DIR/.vob-config" "$TARGET/"

# Stamp install.json with the actual install timestamp.
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
INSTALL_JSON="$TARGET/.vob/install.json"
if [[ -f "$INSTALL_JSON" ]]; then
  python3 -c "import json,sys
p=sys.argv[1]; d=json.load(open(p)); d['installed_at']=sys.argv[2]
json.dump(d, open(p,'w'), indent=2); open(p,'a').write('\n')" "$INSTALL_JSON" "$TS" 2>/dev/null \
    || sed -i.bak "s/\"TEMPLATE\"/\"$TS\"/" "$INSTALL_JSON" && rm -f "$INSTALL_JSON.bak"
fi

echo "video-vob ($ADAPTER adapter) installed into $TARGET"
echo "next: cd $TARGET && claude   # or your chosen CLI"
