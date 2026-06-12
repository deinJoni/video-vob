# video-vob editing invariants

MCP-owned JSON is the only authoritative source for FSM state. `state.json` lives in
`~/video-vob-sessions/<project_id>/` and is read/written exclusively by `mcp__vob__vob_*` tools
(a PreToolUse hook blocks direct writes there). Markdown/JSON artifacts produced in later phases
(briefs, storyboards, compositions) exist for humans and debugging — never parse them as state.
If a markdown artifact disagrees with `state.json`, the JSON wins.

Never skip forward through the FSM. The allowed transition map in `mcp/lib/session-state.js` is
the contract; every legal advance crosses exactly one edge. Back-edges are explicit — use them
when a downstream phase reveals an upstream problem (e.g. `PREVIEW → PLAN` when the cut plan is
wrong) rather than patching forward. Gate-blocked transitions can carry an `override_reason`
(recorded in `state.json.history` for audit), but the server REFUSES overrides for
inspect-acknowledgement and preview/render confirmation — those gates always require the human.
