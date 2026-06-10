# ITERATE — terminal phase, offer iteration or done
Spine rules 2, 10, 11 apply.

ITERATE is the end of the FSM. The user has a packaged video; they can stop (project done) or
back-edge to revise — back-edges from ITERATE archive the current iteration automatically.

## Read sites
| step | source | fields |
|---|---|---|
| 1 | `vob_finalize_iteration` result | `iteration_version, package_directory_path, finalized_at` |
| 3 | `vob_transition_phase` response | `archived.{version, paths}` |

1. Call `vob_vob_finalize_iteration { project_id }`. Records that ITERATE was reached for
   the current iteration version. Idempotent — safe to call on re-entry without an intervening
   back-edge.

2. Present the result: "iteration v<iteration_version> complete. Your packaged video is at
   `<package.final_mp4_path>`. Three options:
   - **done** — keep this version, walk away
   - **revise the composition** (cuts, overlays, captions, timing) → back-edge to COMPOSE
   - **revise the plan** (scene order, beats, tone) → back-edge to PLAN
   Either revision archives the current iteration as v<iteration_version> and starts a fresh
   pass."
   Fan-out: the deliverable set lives under `deliverables/` (manifest:
   `deliverables/manifest.json`) — present the per-short list instead of a single
   `final_mp4_path`.

3. Handle the response:
   - **Done** — congratulate, surface the package paths one more time, stop. Do not transition.
   - **Revise composition** → `vob_vob_transition_phase { project_id, to_phase:
     "COMPOSE" }`. The transition response's `archived.paths` carries the archive locations
     (spine rule 10) — surface them: "archived v<N> at <paths>. Starting v<N+1>." Re-enter
     COMPOSE. **Fan-out: ask WHICH short to revise first** (every short already has a
     deliverable record, so COMPOSE.md's active-short rule needs the user's pick) and carry
     that `short_id` into COMPOSE; the re-rendered short's re-import REPLACES its record.
   - **Revise the plan** → same shape with `to_phase: "PLAN"`. Surface archive paths, re-enter
     PLAN.

4. The user never loses prior iterations — if they ask where v1 went after iterating to v2,
   point at `~/video-vob-sessions/<project_id>/archive/v1/`.
