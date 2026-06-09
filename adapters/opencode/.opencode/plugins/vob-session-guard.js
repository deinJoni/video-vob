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
        throw new Error(
          `video-vob: refusing to ${input.tool} inside ~/video-vob-sessions/ — ` +
            "FSM state is owned exclusively by the vob MCP tools (vob_vob_*). " +
            "Drive the pipeline through those tools, never by editing session files directly.",
        );
      }
    },
  };
};
