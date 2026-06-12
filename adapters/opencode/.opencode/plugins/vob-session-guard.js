// video-vob session write-guard (OpenCode plugin).
//
// FSM state under ~/video-vob-sessions/ is owned EXCLUSIVELY by the vob MCP
// server (the `vob_vob_*` tools). No agent — not the orchestrator, not a
// subagent, not the default build agent the user might switch to — may write
// there directly. The vob agents already disable write/edit/patch in their own
// tool config; this plugin is the belt-and-suspenders guard that ALSO covers any
// other primary agent. It intercepts file-mutating tool calls before they run
// and throws when the target is inside the session root, which aborts the call.
//
// Note: opencode issue #5894 reports `tool.execute.before` may not fire for
// SUBAGENT tool calls. That gap is closed separately — each vob subagent has
// write/edit/patch disabled in its own frontmatter, so it cannot mutate files
// regardless of whether this hook sees its calls.
//
// ONE sanctioned carve-out: <session>/<project>/work/ — the escape-hatch
// scratch dir (vob.md Rule 8: user-approved overlay-over-base / bespoke ffmpeg
// builds work there; results are recorded via vob_vob_import_deliverable).
// path.resolve normalizes ".."/"." before the segment check, so the carve-out
// can't be steered back into state.json. The claude-code hook
// (session-write-guard.sh) mirrors the semantics.
import os from "os";
import path from "path";

const SESSION_ROOT = path.join(os.homedir(), "video-vob-sessions");
const MUTATING_TOOLS = new Set(["write", "edit", "patch"]);

export const VobSessionGuard = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (!MUTATING_TOOLS.has(input.tool)) return;
      const args = (output && output.args) || {};
      const target = args.filePath || args.path || args.file || "";
      if (typeof target !== "string" || target.length === 0) return;
      const resolved = path.resolve(target);
      if (resolved === SESSION_ROOT || resolved.startsWith(SESSION_ROOT + path.sep)) {
        // Segment-exact carve-out: <root>/<project>/work[/...] — the second
        // path segment under the root must be exactly "work".
        const rel = path.relative(SESSION_ROOT, resolved);
        const segments = rel.split(path.sep);
        if (segments.length >= 2 && segments[1] === "work") return;
        throw new Error(
          `video-vob: refusing to ${input.tool} inside ~/video-vob-sessions/ — ` +
            "FSM state is owned exclusively by the vob MCP tools (vob_vob_*). " +
            "Drive the pipeline through those tools, never by editing session files directly " +
            "(escape-hatch scratch work belongs under <session>/work/).",
        );
      }
    },
  };
};
