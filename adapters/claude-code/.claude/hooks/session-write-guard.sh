#!/bin/bash
# video-vob session write-guard (PreToolUse: Write|Edit|NotebookEdit).
# Session state under ~/video-vob-sessions/ is owned EXCLUSIVELY by the vob MCP
# server. Blocks any direct Write/Edit targeting that tree (exit 2 = block, the
# stderr message is shown to the model). READS are not hooked — cross-project
# reads power --like style inheritance. The MCP server writes from its own
# process and is unaffected.
#
# ONE sanctioned carve-out: <session>/<project>/work/ — the escape-hatch
# scratch dir (SKILL.md Rule 8: user-approved overlay-over-base / bespoke
# ffmpeg builds work there; results are recorded via vob_import_deliverable).
# The check is segment-exact (second path segment == "work") and rejects any
# path containing "."/".." segments so the carve-out can't be steered back into
# state.json. The OpenCode plugin (vob-session-guard.js) mirrors the semantics.
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
    # Dot-segment paths could resolve back out of work/ after we allow them —
    # always block them inside the session tree.
    case "$ABS" in
      */../*|*/..|*/./*|*/.)
        echo "video-vob: blocked direct write to $ABS — '.'/'..' segments are not allowed inside ~/video-vob-sessions/." >&2
        exit 2
        ;;
    esac
    # Carve-out: $SESSION_ROOT/<project>/work[/...] — segment-exact, the
    # project is exactly one path segment, work is exactly the second.
    REL="${ABS#"$SESSION_ROOT"/}"
    if [ "$REL" != "$ABS" ] && [ "$REL" != "${REL#*/}" ]; then
      SUB="${REL#*/}"
      case "$SUB" in
        work|work/*)
          exit 0
          ;;
      esac
    fi
    echo "video-vob: blocked direct write to $ABS — files under ~/video-vob-sessions/ are owned by the vob MCP tools (mcp__vob__vob_*). Use the appropriate vob tool instead (escape-hatch scratch work belongs under <session>/work/)." >&2
    exit 2
    ;;
esac
exit 0
