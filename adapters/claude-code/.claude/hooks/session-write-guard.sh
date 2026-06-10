#!/bin/bash
# video-vob session write-guard (PreToolUse: Write|Edit|NotebookEdit).
# Session state under ~/video-vob-sessions/ is owned EXCLUSIVELY by the vob MCP
# server. Blocks any direct Write/Edit targeting that tree (exit 2 = block, the
# stderr message is shown to the model). READS are not hooked — cross-project
# reads power --like style inheritance. The MCP server writes from its own
# process and is unaffected.
set -u
INPUT="$(cat)"
TARGET="$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(""); raise SystemExit
ti = d.get("tool_input") or {}
print(ti.get("file_path") or ti.get("notebook_path") or "")
' 2>/dev/null)"
# Fallback if python3 is unavailable: crude extraction of "file_path":"..."
if [ -z "$TARGET" ]; then
  TARGET="$(printf '%s' "$INPUT" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
fi
[ -z "$TARGET" ] && exit 0
case "$TARGET" in "~/"*) TARGET="$HOME/${TARGET#\~/}" ;; esac
case "$TARGET" in
  /*) ABS="$TARGET" ;;
  *)  ABS="$PWD/$TARGET" ;;
esac
SESSION_ROOT="$HOME/video-vob-sessions"
case "$ABS" in
  "$SESSION_ROOT"|"$SESSION_ROOT"/*)
    echo "video-vob: blocked direct write to $ABS — files under ~/video-vob-sessions/ are owned by the vob MCP tools (mcp__vob__vob_*). Use the appropriate vob tool instead." >&2
    exit 2
    ;;
esac
exit 0
