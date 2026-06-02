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

  const verdict = validateClassification({ aroll_pool: arollPool, broll_index: brollIndex, review }, segmentsDoc);
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
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return { ...classification };
  });
}

module.exports = Object.freeze({
  name: "vob_save_classification",
  description: "Persist the three INSPECT classification pools produced by the inspector subagent from inspect/segments.json: aroll_pool.json (spine segments, with take_group + is_best_take for deduped retakes), broll_index.json (B-roll clips with description/tags/has_motion/has_usable_audio), and review.json (ambiguous segments, empty for a clean drop). Validates shape AND that every referenced { file_index, segment_index } exists in segments.json (no hallucinated segments). Records state.inspect.classification with pool paths + counts. Requires phase INSPECT and a prior vob_inspect_source. The inspector subagent's only write tool.",
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
