"use strict";

const fs = require("fs");
const path = require("path");

const { readSessionStateStrict } = require("../session-state.js");
const { archiveSnapshotPath, archiveVersionDir } = require("../paths.js");
const { readJsonFile } = require("../storage.js");
const { allStoryboardScenes } = require("../storyboard-schema.js");
const { ERROR_CODES, ToolError } = require("../envelope.js");

// Read JSON from disk, tolerating absence/corruption: a missing or unparseable
// file returns null (the caller decides whether that null is fatal — a
// ledger-listed snapshot that won't read is a lie worth surfacing; a missing
// archived storyboard just degrades that side's scene fields to "unknown").
function readJsonOrNull(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return readJsonFile(filePath);
  } catch {
    return null;
  }
}

// round to 3 decimals, mirroring render verification's drift precision; only
// reached when both operands are finite numbers (the diff never coerces a
// missing numerator to 0 — see the null-semantics note below).
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function intOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

// Ordered scene-id list across single-timeline / fan-out (shorts[]) / segmented
// (segments[]) storyboards — allStoryboardScenes is the mode-agnostic accessor
// every consumer uses. Returns null when the storyboard copy is absent/unreadable
// (legacy archive predating the storyboard copy) so the diff reads "unknown".
function orderedSceneIds(storyboard) {
  if (!storyboard || typeof storyboard !== "object") return null;
  try {
    return allStoryboardScenes(storyboard)
      .map((scene) => (scene && typeof scene.scene_id === "string" ? scene.scene_id : null))
      .filter((id) => id != null);
  } catch {
    return null;
  }
}

// Per-side load: the snapshot (slot-level deltas) + the archived storyboard copy
// (scene content — NOT embedded in the snapshot). A missing snapshot for a
// ledger-listed version is a NOT_FOUND (the ledger lied). A missing storyboard
// degrades scene fields, never the whole side.
function loadArchivedSide(projectId, version, record) {
  const snapshotPath = archiveSnapshotPath(projectId, version);
  const snapshot = readJsonOrNull(snapshotPath);
  if (!snapshot || typeof snapshot !== "object") {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `archive snapshot for v${version} is missing or unreadable`,
      { version, snapshot_path: snapshotPath },
    );
  }

  const storyboardPath = path.join(archiveVersionDir(projectId, version), "storyboard.json");
  const storyboard = readJsonOrNull(storyboardPath);
  const sceneIds = orderedSceneIds(storyboard);

  const render = snapshot.render && typeof snapshot.render === "object" ? snapshot.render : null;
  return {
    version,
    archived_at: record && typeof record.archived_at === "string" ? record.archived_at : (
      typeof snapshot.archived_at === "string" ? snapshot.archived_at : null
    ),
    from_phase: typeof snapshot.from_phase === "string" ? snapshot.from_phase : null,
    to_phase: typeof snapshot.to_phase === "string" ? snapshot.to_phase : null,
    render_duration_seconds: render ? finiteOrNull(render.render_duration_seconds) : null,
    file_size_bytes: render ? intOrNull(render.file_size_bytes) : null,
    composition_revision: intOrNull(snapshot.composition_revision_at_archive),
    storyboard_revision: intOrNull(snapshot.storyboard_revision_at_archive),
    scene_count: sceneIds === null ? null : sceneIds.length,
    storyboard_readable: sceneIds !== null,
    _scene_ids: sceneIds,
  };
}

// Set difference preserving the order of the minuend.
function difference(a, b) {
  const inB = new Set(b);
  return a.filter((id) => !inB.has(id));
}

// Ids common to both sides whose RANK among the common ids differs between sides.
// Stable: compare each id's index in the from-common ordering vs the to-common
// ordering (both projected onto the shared set), flag the ones that moved.
function reorderedIds(fromIds, toIds) {
  const toSet = new Set(toIds);
  const fromCommon = fromIds.filter((id) => toSet.has(id));
  const fromSet = new Set(fromIds);
  const toCommon = toIds.filter((id) => fromSet.has(id));
  const toRank = new Map(toCommon.map((id, index) => [id, index]));
  const moved = [];
  for (let i = 0; i < fromCommon.length; i += 1) {
    const id = fromCommon[i];
    if (toRank.get(id) !== i) moved.push(id);
  }
  return moved;
}

function buildSceneDiff(fromSide, toSide) {
  // Either storyboard unreadable ⇒ no scene-level diff is trustworthy.
  if (fromSide._scene_ids === null || toSide._scene_ids === null) {
    return { scene_count_delta: null, scenes: { added: [], removed: [], reordered: [] } };
  }
  const fromIds = fromSide._scene_ids;
  const toIds = toSide._scene_ids;
  return {
    scene_count_delta: toIds.length - fromIds.length,
    scenes: {
      added: difference(toIds, fromIds),
      removed: difference(fromIds, toIds),
      reordered: reorderedIds(fromIds, toIds),
    },
  };
}

// Numeric delta with load-bearing null semantics: null (unknown) when EITHER
// side lacks the datum, never a fabricated 0.
function numericDelta(from, to, { round = false } = {}) {
  if (from == null || to == null) return null;
  const delta = to - from;
  return round ? round3(delta) : delta;
}

// Public-facing per-side projection (drops the internal _scene_ids field).
function publicSide(side) {
  return {
    version: side.version,
    archived_at: side.archived_at,
    from_phase: side.from_phase,
    to_phase: side.to_phase,
    render_duration_seconds: side.render_duration_seconds,
    file_size_bytes: side.file_size_bytes,
    composition_revision: side.composition_revision,
    storyboard_revision: side.storyboard_revision,
    scene_count: side.scene_count,
    storyboard_readable: side.storyboard_readable,
  };
}

// Forward-compat feedback gating: until the revision-capture PRD lands
// state.iteration.feedback[] does not exist, so this is always null. The
// presence check lights it up automatically afterward — no schema edit here.
function selectFeedbackForVersions(feedback, versions) {
  const wanted = new Set(versions.filter((v) => Number.isInteger(v)));
  return feedback.filter((entry) => entry && Number.isInteger(entry.version) && wanted.has(entry.version));
}

function compareIterations(args) {
  const projectId = args && typeof args.project_id === "string" ? args.project_id : "";
  if (!projectId) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "project_id is required");
  }

  // Belt-and-braces on top of the schema: a positive integer or the literal
  // "live" sentinel, nothing else.
  function checkVersionArg(name, value) {
    if (value === undefined) return;
    if (name === "to_version" && value === "live") return;
    if (Number.isInteger(value) && value >= 1) return;
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `${name} must be a positive integer${name === "to_version" ? ' or "live"' : ""}`,
    );
  }
  checkVersionArg("from_version", args.from_version);
  checkVersionArg("to_version", args.to_version);

  const state = readSessionStateStrict(projectId);
  const iteration = state.iteration && typeof state.iteration === "object" ? state.iteration : {};
  const archive = Array.isArray(iteration.archive) ? iteration.archive : [];

  // The ledger is append-only and version-ascending but NOT dense (a back-edge
  // with nothing to archive bumps nothing — v1 then v3 is legal). Resolve the
  // version list strictly from it.
  const recordByVersion = new Map();
  for (const record of archive) {
    if (record && Number.isInteger(record.version)) recordByVersion.set(record.version, record);
  }
  const versions = [...recordByVersion.keys()].sort((a, b) => a - b);

  const fb = Array.isArray(iteration.feedback) ? iteration.feedback : null;
  const wantLive = args.to_version === "live";

  // --- live-side target: archived `from` vs the live working copy -----------
  if (wantLive) {
    // Default the from side to the highest archived version.
    let fromVersion = args.from_version;
    if (fromVersion === undefined) {
      if (versions.length < 1) {
        throw new ToolError(
          ERROR_CODES.NOT_FOUND,
          "no archived iterations to compare against the live working copy",
          { available: versions },
        );
      }
      fromVersion = versions[versions.length - 1];
    } else if (!recordByVersion.has(fromVersion)) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        `from_version ${fromVersion} is not in the archive ledger`,
        { requested: fromVersion, available: versions },
      );
    }

    const fromSide = loadArchivedSide(projectId, fromVersion, recordByVersion.get(fromVersion));

    // The live side is honoured only if a render actually exists on disk — disk
    // is the truth (a back-edge deletes the render slot; a stale read must not
    // fake a render into existence). render.mp4_path is stored ABSOLUTE.
    const render = state.render && typeof state.render === "object" ? state.render : null;
    const mp4Path = render && typeof render.mp4_path === "string" ? render.mp4_path : null;
    const liveAvailable = Boolean(mp4Path && fs.existsSync(mp4Path));

    if (!liveAvailable) {
      return {
        project_id: projectId,
        from: publicSide(fromSide),
        to: { version: "live", available: false, reason: "live side has no render yet" },
        diff: null,
        available_versions: versions,
        feedback: fb ? selectFeedbackForVersions(fb, [fromVersion]) : null,
      };
    }

    const toSide = {
      version: "live",
      archived_at: null,
      from_phase: typeof state.phase === "string" ? state.phase : null,
      to_phase: null,
      render_duration_seconds: finiteOrNull(render.render_duration_seconds),
      file_size_bytes: intOrNull(render.file_size_bytes),
      composition_revision: state.composition && Number.isInteger(state.composition.revision_count)
        ? state.composition.revision_count
        : null,
      storyboard_revision: state.storyboard && Number.isInteger(state.storyboard.revision_count)
        ? state.storyboard.revision_count
        : null,
      scene_count: null,
      storyboard_readable: false,
      // The live working storyboard lives at storyboard.json (session-relative,
      // not under archive/), but the lean live-target path deliberately skips
      // scene enumeration: live-vs-archived diffs structured slots only (scene
      // content stays archived-vs-archived). Keep scene fields null/unknown.
      _scene_ids: null,
    };

    const diff = {
      duration_delta_seconds: numericDelta(fromSide.render_duration_seconds, toSide.render_duration_seconds, { round: true }),
      file_size_delta_bytes: numericDelta(fromSide.file_size_bytes, toSide.file_size_bytes),
      composition_revision_delta: numericDelta(fromSide.composition_revision, toSide.composition_revision),
      storyboard_revision_delta: numericDelta(fromSide.storyboard_revision, toSide.storyboard_revision),
      ...buildSceneDiff(fromSide, toSide),
    };

    return {
      project_id: projectId,
      from: publicSide(fromSide),
      to: { version: "live", available: true, ...publicSide(toSide) },
      diff,
      available_versions: versions,
      feedback: fb ? selectFeedbackForVersions(fb, [fromVersion]) : null,
    };
  }

  // --- archived-vs-archived (the canonical default) -------------------------
  let fromVersion = args.from_version;
  let toVersion = args.to_version;

  if (fromVersion === undefined && toVersion === undefined) {
    if (versions.length < 2) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        "fewer than two archived iterations to compare",
        { available: versions },
      );
    }
    toVersion = versions[versions.length - 1];
    fromVersion = versions[versions.length - 2];
  } else {
    // Partial defaults: fill the unspecified side from the ledger ends, then
    // validate every explicit value by MEMBERSHIP (honours non-dense ledgers).
    if (toVersion === undefined) {
      if (versions.length < 1) {
        throw new ToolError(ERROR_CODES.NOT_FOUND, "no archived iterations to compare", { available: versions });
      }
      toVersion = versions[versions.length - 1];
    }
    if (fromVersion === undefined) {
      const below = versions.filter((v) => v < toVersion);
      if (below.length === 0) {
        throw new ToolError(
          ERROR_CODES.NOT_FOUND,
          "no earlier archived iteration to compare against",
          { requested: toVersion, available: versions },
        );
      }
      fromVersion = below[below.length - 1];
    }
  }

  for (const [name, value] of [["from_version", fromVersion], ["to_version", toVersion]]) {
    if (!recordByVersion.has(value)) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        `${name} ${value} is not in the archive ledger`,
        { requested: value, available: versions },
      );
    }
  }

  const fromSide = loadArchivedSide(projectId, fromVersion, recordByVersion.get(fromVersion));
  const toSide = loadArchivedSide(projectId, toVersion, recordByVersion.get(toVersion));

  const diff = {
    duration_delta_seconds: numericDelta(fromSide.render_duration_seconds, toSide.render_duration_seconds, { round: true }),
    file_size_delta_bytes: numericDelta(fromSide.file_size_bytes, toSide.file_size_bytes),
    composition_revision_delta: numericDelta(fromSide.composition_revision, toSide.composition_revision),
    storyboard_revision_delta: numericDelta(fromSide.storyboard_revision, toSide.storyboard_revision),
    ...buildSceneDiff(fromSide, toSide),
  };

  return {
    project_id: projectId,
    from: publicSide(fromSide),
    to: publicSide(toSide),
    diff,
    available_versions: versions,
    feedback: fb ? selectFeedbackForVersions(fb, [fromVersion, toVersion]) : null,
  };
}

module.exports = Object.freeze({
  name: "vob_compare_iterations",
  description: "Read-only diff between two archived iterations (from iteration.archive[]): render duration + file-size deltas, composition/storyboard revision deltas, and the scene-id set delta (added/removed/reordered). Defaults to the two most recent archived versions. Versions are non-dense — validated against the ledger, NOT_FOUND on a miss. Pass to_version:\"live\" to diff against the live working copy (honoured only when a render exists on disk, else to.available:false). Treats missing render/scene data as unknown (null), never zero.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      from_version: { type: "integer", minimum: 1 },
      to_version: {
        oneOf: [
          { type: "integer", minimum: 1 },
          { type: "string", enum: ["live"] },
        ],
      },
    },
    required: ["project_id"],
  },
  handler: compareIterations,
  role_bundles: ["orchestrator"],
  mutating: false,
  global_preapproval: true,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: [],
  hook_required: false,
});
