"use strict";

const fs = require("fs");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  arollPoolPath,
  brollIndexPath,
  reviewPoolPath,
  segmentsPath,
  statePath,
} = require("../paths.js");
const { readJsonFile, withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { SCHEMA_VERSION, validateClassification } = require("../classification-schema.js");

function nowIso() {
  return new Date().toISOString();
}

function countBestTakes(arollPool) {
  const segs = arollPool && Array.isArray(arollPool.segments) ? arollPool.segments : [];
  return segs.filter((s) => s && s.is_best_take === true).length;
}

function countTakeGroups(arollPool) {
  const segs = arollPool && Array.isArray(arollPool.segments) ? arollPool.segments : [];
  const groups = new Set();
  for (const s of segs) {
    if (s && typeof s.take_group === "string" && s.take_group.trim()) groups.add(s.take_group);
  }
  // Prefer an explicit take_groups list when the agent supplied one.
  if (arollPool && Array.isArray(arollPool.take_groups) && arollPool.take_groups.length > 0) {
    return arollPool.take_groups.length;
  }
  return groups.size;
}

// "Visually tagged" = the entry carries BOTH structured visual fields the
// inspector prompt requires (shot_type + framing_ok_for_vertical). The
// orchestrator surfaces under-coverage as a quality note, never a hard gate.
function countVisualTagged(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.shot_type !== undefined && e.framing_ok_for_vertical !== undefined)
    .length;
}

// Hook tags live on BOTH pools: the inspector tags A-roll segments (strong
// opening lines) and B-roll clips (arresting motion / striking frames).
function countHookTagged(arollPool, brollIndex) {
  const segs = arollPool && Array.isArray(arollPool.segments) ? arollPool.segments : [];
  const clips = brollIndex && Array.isArray(brollIndex.clips) ? brollIndex.clips : [];
  return segs.filter((s) => s && s.hook_candidate === true).length
    + clips.filter((c) => c && c.hook_candidate === true).length;
}

// v3.2 P3 quality notes (never gates, like visual_coverage). Counted across BOTH
// pools: entries that carry non-empty content_tags, and entries with on-screen
// text the inspector read off the frame.
function poolEntries(arollPool, brollIndex) {
  const segs = arollPool && Array.isArray(arollPool.segments) ? arollPool.segments : [];
  const clips = brollIndex && Array.isArray(brollIndex.clips) ? brollIndex.clips : [];
  return [...segs, ...clips];
}
function countContentTagged(arollPool, brollIndex) {
  return poolEntries(arollPool, brollIndex)
    .filter((e) => e && Array.isArray(e.content_tags) && e.content_tags.length > 0).length;
}
function countOnScreenText(arollPool, brollIndex) {
  return poolEntries(arollPool, brollIndex)
    .filter((e) => e && typeof e.on_screen_text === "string" && e.on_screen_text.trim() !== "").length;
}

// The inspector subagent's single write. Validates the three classification
// pools against inspect/segments.json (the authoritative segment list), then
// persists inspect/{aroll_pool,broll_index,review}.json and records pool paths
// + counts on state.inspect.classification. Runs during INSPECT, after
// vob_inspect_source and before vob_acknowledge_inspect.
function saveClassification(args) {
  const id = assertSafeProjectId(args && args.project_id);

  const arollPool = args && args.aroll_pool;
  const brollIndex = args && args.broll_index;
  const review = args && args.review;
  const fileRoles = args && args.file_roles; // optional (v3.2 P3)

  const state = readSessionStateStrict(id);
  if (state.phase !== "INSPECT") {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      `vob_save_classification requires phase INSPECT, current phase is ${state.phase}.`,
    );
  }
  const inspect = state.inspect && typeof state.inspect === "object" && !Array.isArray(state.inspect) ? state.inspect : null;
  const segPath = inspect && typeof inspect.segments_path === "string" ? inspect.segments_path : segmentsPath(id);
  if (!fs.existsSync(segPath)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      "inspect/segments.json is missing — run vob_inspect_source before classifying segments",
    );
  }
  let segmentsDoc;
  try {
    segmentsDoc = readJsonFile(segPath);
  } catch (error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `inspect/segments.json could not be read: ${error.message || String(error)}`,
    );
  }

  const payload = { aroll_pool: arollPool, broll_index: brollIndex, review };
  if (fileRoles !== undefined) payload.file_roles = fileRoles;
  const verdict = validateClassification(payload, segmentsDoc);
  if (!verdict.ok) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `classification failed validation: ${verdict.errors.slice(0, 10).join("; ")}${verdict.errors.length > 10 ? ` (+${verdict.errors.length - 10} more)` : ""}`,
      { errors: verdict.errors },
    );
  }

  const ts = nowIso();
  const stamp = { schema_version: SCHEMA_VERSION, project_id: id, generated_at: ts };
  const arollDoc = { ...stamp, ...arollPool };
  const brollDoc = { ...stamp, ...brollIndex };
  const reviewDoc = { ...stamp, ...review };

  const arollAbs = arollPoolPath(id);
  const brollAbs = brollIndexPath(id);
  const reviewAbs = reviewPoolPath(id);

  const arollCount = Array.isArray(arollPool.segments) ? arollPool.segments.length : 0;
  const brollCount = Array.isArray(brollIndex.clips) ? brollIndex.clips.length : 0;
  const reviewCount = Array.isArray(review.segments) ? review.segments.length : 0;

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const inspectNow = stateNow.inspect && typeof stateNow.inspect === "object" && !Array.isArray(stateNow.inspect)
      ? stateNow.inspect
      : null;
    if (!inspectNow) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        "state.inspect disappeared between read and classification commit — re-run vob_inspect_source",
      );
    }

    writeFileAtomic(arollAbs, `${JSON.stringify(arollDoc, null, 2)}\n`);
    writeFileAtomic(brollAbs, `${JSON.stringify(brollDoc, null, 2)}\n`);
    writeFileAtomic(reviewAbs, `${JSON.stringify(reviewDoc, null, 2)}\n`);

    const classification = {
      aroll_pool_path: arollAbs,
      broll_index_path: brollAbs,
      review_path: reviewAbs,
      aroll_count: arollCount,
      broll_count: brollCount,
      review_count: reviewCount,
      best_take_count: countBestTakes(arollPool),
      take_group_count: countTakeGroups(arollPool),
      visual_coverage: {
        aroll_tagged: countVisualTagged(arollPool.segments),
        aroll_total: arollCount,
        broll_tagged: countVisualTagged(brollIndex.clips),
        broll_total: brollCount,
      },
      hook_tagged_count: countHookTagged(arollPool, brollIndex),
      // v3.2 P3 — richer-tagging coverage notes + the multi-file role map.
      content_tagged_count: countContentTagged(arollPool, brollIndex),
      on_screen_text_count: countOnScreenText(arollPool, brollIndex),
      file_role_count: Array.isArray(fileRoles) ? fileRoles.length : 0,
      file_roles: Array.isArray(fileRoles) ? fileRoles : [],
      classified_at: ts,
    };

    const next = {
      ...stateNow,
      inspect: { ...inspectNow, classification },
      last_updated: ts,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "segments_classified",
          at: ts,
          aroll_count: arollCount,
          broll_count: brollCount,
          review_count: reviewCount,
          take_group_count: classification.take_group_count,
          hook_tagged_count: classification.hook_tagged_count,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return { ...classification };
  });
}

module.exports = Object.freeze({
  name: "vob_save_classification",
  description: "Persist the inspector's three classification pools validated against inspect/segments.json (hallucinated {file_index,segment_index} refs are rejected): aroll_pool (take_group/is_best_take/hook_candidate/content_description/eyes_to_camera), broll_index (description/tags/has_motion/has_usable_audio/hook_candidate/b_roll_role), review, plus an optional top-level file_roles[] map ({file_index, role: primary_aroll|broll|narration|mixed, summary}) for multi-file drops. Entries should carry the structured visual fields shot_type, subject_position, framing_ok_for_vertical, and the richer camera_movement/setting/content_tags/on_screen_text/action — the return's visual_coverage + content_tagged_count/on_screen_text_count/file_role_count report coverage (quality notes, never gates). Requires phase INSPECT after vob_inspect_source. Inspector's only write tool.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      // Free-form object payloads — the deep shape (segments[]/clips[] + their
      // fields, and the cross-reference against segments.json) is validated by
      // the handler's validateClassification(). additionalProperties:true is
      // REQUIRED: tool-validation.js defaults additionalProperties to false, so
      // a bare { type:"object" } here rejects every nested key. Mirrors the
      // init-project.js `target` convention.
      aroll_pool: { type: "object", additionalProperties: true },
      broll_index: { type: "object", additionalProperties: true },
      review: { type: "object", additionalProperties: true },
      // Optional (v3.2 P3) top-level per-file role map. Free-form entries —
      // shape ({file_index, role, summary}) validated by the handler.
      file_roles: { type: "array", items: { type: "object", additionalProperties: true } },
    },
    required: ["project_id", "aroll_pool", "broll_index", "review"],
  },
  handler: saveClassification,
  role_bundles: ["inspector"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["inspect/aroll_pool.json", "inspect/broll_index.json", "inspect/review.json", "state.json"],
  hook_required: false,
});
