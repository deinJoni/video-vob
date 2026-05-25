"use strict";

const os = require("os");
const path = require("path");
const { SESSION_LOCK_NAME } = require("./constants.js");

function assertSafeProjectId(projectId) {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new Error("project_id must be a non-empty string");
  }
  const trimmed = projectId.trim();
  if (/[\/\\]/.test(trimmed) || /(?:^|\.)\.\.(?:\.|$)/.test(trimmed)) {
    throw new Error(`project_id contains invalid path characters: ${trimmed}`);
  }
  return trimmed;
}

function sessionsRoot() {
  return path.join(os.homedir(), "video-vob-sessions");
}

function sessionDir(projectId) {
  return path.join(sessionsRoot(), assertSafeProjectId(projectId));
}

function statePath(projectId) {
  return path.join(sessionDir(projectId), "state.json");
}

function sessionLockPath(projectId) {
  return path.join(sessionDir(projectId), SESSION_LOCK_NAME);
}

function manifestPath(projectId) {
  return path.join(sessionDir(projectId), "manifest.json");
}

function briefPath(projectId) {
  return path.join(sessionDir(projectId), "brief.md");
}

function ingestDir(projectId) {
  return path.join(sessionDir(projectId), "ingest");
}

function storyboardPath(projectId) {
  return path.join(sessionDir(projectId), "storyboard.json");
}

function storyboardMarkdownPath(projectId) {
  return path.join(sessionDir(projectId), "storyboard.md");
}

function composeDir(projectId) {
  return path.join(sessionDir(projectId), "compose");
}

function previewDir(projectId) {
  return path.join(sessionDir(projectId), "preview");
}

function rendersDir(projectId) {
  return path.join(sessionDir(projectId), "renders");
}

function packageDir(projectId) {
  return path.join(sessionDir(projectId), "package");
}

function packageFinalMp4Path(projectId) {
  return path.join(packageDir(projectId), "final.mp4");
}

function packageThumbnailPath(projectId) {
  return path.join(packageDir(projectId), "thumbnail.jpg");
}

function packageManifestPath(projectId) {
  return path.join(packageDir(projectId), "manifest.json");
}

function packageReadmePath(projectId) {
  return path.join(packageDir(projectId), "README.md");
}

function archiveDir(projectId) {
  return path.join(sessionDir(projectId), "archive");
}

function archiveVersionDir(projectId, version) {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`archive version must be a positive integer, got ${version}`);
  }
  return path.join(archiveDir(projectId), `v${version}`);
}

function archiveSnapshotPath(projectId, version) {
  return path.join(archiveVersionDir(projectId, version), "snapshot.json");
}

module.exports = {
  archiveDir,
  archiveSnapshotPath,
  archiveVersionDir,
  assertSafeProjectId,
  briefPath,
  composeDir,
  ingestDir,
  manifestPath,
  packageDir,
  packageFinalMp4Path,
  packageManifestPath,
  packageReadmePath,
  packageThumbnailPath,
  previewDir,
  rendersDir,
  sessionDir,
  sessionLockPath,
  sessionsRoot,
  statePath,
  storyboardMarkdownPath,
  storyboardPath,
};
