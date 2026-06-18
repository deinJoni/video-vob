"use strict";

const fs = require("fs");
const path = require("path");

const {
  archiveDir,
  archiveSnapshotPath,
  archiveVersionDir,
  briefPath,
  composeDir,
  composeSourceDir,
  packageDir,
  rendersDir,
  segmentRendersDir,
  sessionDir,
  storyboardPath,
} = require("./paths.js");
const { writeFileAtomic } = require("./storage.js");

const ARCHIVE_FROM = new Set(["RENDER", "PACKAGE", "ITERATE"]);
const ARCHIVE_TO = new Set(["COMPOSE", "PLAN"]);

function nowIso() {
  return new Date().toISOString();
}

// Is the (from, to) phase pair a back-edge that should trigger versioned
// archival of the current iteration's renders/package?
function isArchivalTransition(from, to) {
  return ARCHIVE_FROM.has(from) && ARCHIVE_TO.has(to);
}

function currentIterationVersion(state) {
  const iter = state && typeof state.iteration === "object" && !Array.isArray(state.iteration)
    ? state.iteration
    : null;
  if (iter && Number.isInteger(iter.current_version) && iter.current_version > 0) {
    return iter.current_version;
  }
  return 1;
}

function currentArchive(state) {
  const iter = state && typeof state.iteration === "object" && !Array.isArray(state.iteration)
    ? state.iteration
    : null;
  return iter && Array.isArray(iter.archive) ? iter.archive : [];
}

function moveIfExists(srcAbs, dstAbs) {
  if (!fs.existsSync(srcAbs)) return false;
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.renameSync(srcAbs, dstAbs);
  return true;
}

// Copy (not move) an artifact into the archive. Used for the intent artifacts
// (brief.md, storyboard.json, compose/) that the NEXT iteration still reads and
// mutates in place — moving them would strand the live working copy. Outputs
// (renders/, package/) are still moved, since the next iteration regenerates
// them from scratch.
function copyIfExists(srcAbs, dstAbs, { filter } = {}) {
  if (!fs.existsSync(srcAbs)) return false;
  fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
  fs.cpSync(srcAbs, dstAbs, { recursive: true, ...(filter ? { filter } : {}) });
  return true;
}

function buildSnapshot(state, { from, to, version, archivedAt }) {
  const tailHistory = Array.isArray(state.history)
    ? state.history.slice(-20)
    : [];
  return {
    version,
    archived_at: archivedAt,
    from_phase: from,
    to_phase: to,
    project_id: state.project_id,
    target: state.target == null ? null : state.target,
    preview: state.preview == null ? null : state.preview,
    render: state.render == null ? null : state.render,
    package: state.package == null ? null : state.package,
    composition_revision_at_archive: state.composition && Number.isInteger(state.composition.revision_count)
      ? state.composition.revision_count
      : null,
    storyboard_revision_at_archive: state.storyboard && Number.isInteger(state.storyboard.revision_count)
      ? state.storyboard.revision_count
      : null,
    tail_history: tailHistory,
  };
}

// Pure-ish archival operation. Performs the fs moves and snapshot write, then
// returns the record + a function that mutates the in-memory state object to
// reflect the archive (clears preview/render/package, bumps iteration counters).
//
// Returns null if there is nothing to archive (no renders/ and no package/) —
// callers should treat that as a no-op transition.
function archiveForIteration(state, { from = state && state.phase, to = null } = {}) {
  if (!state || typeof state !== "object" || typeof state.project_id !== "string") {
    throw new Error("archiveForIteration: invalid state");
  }
  const projectId = state.project_id;
  const rendersSrc = rendersDir(projectId);
  const packageSrc = packageDir(projectId);
  // segment_renders/ holds the per-segment partials being ACCUMULATED for
  // assembly. The per-segment RENDER→COMPOSE back-edge (render segment N → compose
  // segment N+1) is an archival transition too, but it must NOT sweep the
  // partials — that's the whole reason they live outside renders/. So archive
  // segment_renders/ ONLY on a genuine cut-completing / plan-changing back-edge
  // (any archival transition EXCEPT RENDER→COMPOSE); else partials would vanish
  // mid-cycle and vob_assemble_video would report them missing.
  const segmentRendersSrc = segmentRendersDir(projectId);
  const sweepSegmentRenders = !(from === "RENDER" && to === "COMPOSE");
  if (!fs.existsSync(rendersSrc) && !fs.existsSync(packageSrc)
    && !(sweepSegmentRenders && fs.existsSync(segmentRendersSrc))) {
    return null;
  }

  const version = currentIterationVersion(state);
  const archivedAt = nowIso();
  const versionRoot = archiveVersionDir(projectId, version);
  fs.mkdirSync(versionRoot, { recursive: true });

  const archivedRendersAbs = path.join(versionRoot, "renders");
  const archivedPackageAbs = path.join(versionRoot, "package");
  const archivedBriefAbs = path.join(versionRoot, "brief.md");
  const archivedStoryboardAbs = path.join(versionRoot, "storyboard.json");
  const archivedComposeAbs = path.join(versionRoot, "compose");
  const archivedSnapshotAbs = archiveSnapshotPath(projectId, version);

  // Outputs: move (the next iteration regenerates them).
  const movedRenders = moveIfExists(rendersSrc, archivedRendersAbs);
  const movedPackage = moveIfExists(packageSrc, archivedPackageAbs);
  const movedSegmentRenders = sweepSegmentRenders
    ? moveIfExists(segmentRendersSrc, path.join(versionRoot, "segment_renders"))
    : false;

  // Intent: copy (the next iteration reads/mutates these in place). This is
  // what makes versions diffable — brief + storyboard + the authored
  // composition, not just the output MP4. The compose/source/ tree is excluded
  // from the snapshot: it's just symlinks to transcoded clips + original
  // sources, not authored intent, and would leave dangling links in the archive.
  const composeSourceAbs = composeSourceDir(projectId);
  const copiedBrief = copyIfExists(briefPath(projectId), archivedBriefAbs);
  const copiedStoryboard = copyIfExists(storyboardPath(projectId), archivedStoryboardAbs);
  const copiedCompose = copyIfExists(composeDir(projectId), archivedComposeAbs, {
    filter: (src) => src !== composeSourceAbs && !src.startsWith(composeSourceAbs + path.sep),
  });

  const sessionRoot = sessionDir(projectId);
  function relToSession(absPath) {
    return path.relative(sessionRoot, absPath);
  }

  const snapshot = buildSnapshot(state, { from, to, version, archivedAt });
  writeFileAtomic(archivedSnapshotAbs, `${JSON.stringify(snapshot, null, 2)}\n`);

  const record = {
    version,
    archived_at: archivedAt,
    paths: {
      renders: movedRenders ? relToSession(archivedRendersAbs) : null,
      package: movedPackage ? relToSession(archivedPackageAbs) : null,
      segment_renders: movedSegmentRenders ? relToSession(path.join(versionRoot, "segment_renders")) : null,
      brief: copiedBrief ? relToSession(archivedBriefAbs) : null,
      storyboard: copiedStoryboard ? relToSession(archivedStoryboardAbs) : null,
      compose: copiedCompose ? relToSession(archivedComposeAbs) : null,
      snapshot: relToSession(archivedSnapshotAbs),
    },
  };

  function apply(targetState) {
    const nextIter = {
      current_version: version + 1,
      archive: [...currentArchive(targetState), record],
    };
    const next = { ...targetState, iteration: nextIter };
    delete next.preview;
    delete next.render;
    delete next.package;
    return next;
  }

  return { record, apply, archived_at: archivedAt, version };
}

module.exports = {
  ARCHIVE_FROM,
  ARCHIVE_TO,
  archiveForIteration,
  currentIterationVersion,
  isArchivalTransition,
};
