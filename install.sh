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
    [[ "$name" == "README.md" ]] && continue
    echo "    - $name"
  done
  exit 1
fi

if [[ ! -d "$SCRIPT_DIR/adapters/$ADAPTER" ]]; then
  echo "unknown adapter: $ADAPTER (looked in $SCRIPT_DIR/adapters/)"
  exit 1
fi

mkdir -p "$TARGET"

cp -R "$SCRIPT_DIR/mcp" "$TARGET/"
cp -R "$SCRIPT_DIR/adapters/$ADAPTER/.claude" "$TARGET/"
cp "$SCRIPT_DIR/adapters/$ADAPTER/.mcp.json" "$TARGET/"
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
