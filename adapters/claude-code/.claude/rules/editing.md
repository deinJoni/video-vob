# video-vob editing invariants

MCP-owned JSON is the only authoritative source for FSM state. `state.json` lives in `~/video-vob-sessions/<project_id>/` and is read/written exclusively by `mcp__vob__vob_*` tools. Markdown artifacts produced in later phases (briefs, storyboards, etc.) exist for humans and debugging — they must not be parsed as state. If a markdown artifact disagrees with `state.json`, the JSON wins.

Never skip forward through the FSM. The allowed transition map in `mcp/lib/session-state.js` is the contract; every legal advance crosses exactly one edge. Back-edges are explicit and exist for a reason — use them when a downstream phase reveals an upstream problem (e.g., from `PREVIEW` back to `STORYBOARD` when the cut plan is wrong) rather than patching forward. Gate-blocked transitions can be overridden with `override_reason`, which is recorded in `state.json.history` for audit.
