"use strict";

const fs = require("fs");
const path = require("path");

const {
  assertSafeProjectId,
  assertSafeSceneId,
  composeSourceDir,
  manifestPath,
  storyboardPath,
  transcodedClipPath,
} = require("./paths.js");

const SOURCE_SUBDIR = "source";

function readManifestSafe(projectId) {
  try {
    const raw = fs.readFileSync(manifestPath(projectId), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return null;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function readStoryboardSafe(projectId) {
  try {
    const raw = fs.readFileSync(storyboardPath(projectId), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return null;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

function resolveSceneClipLinks(projectId) {
  const id = assertSafeProjectId(projectId);
  const sb = readStoryboardSafe(id);
  if (!sb || !Array.isArray(sb.scenes)) return [];
  const linkDir = composeSourceDir(id);
  const tuples = [];
  for (const scene of sb.scenes) {
    if (!scene || typeof scene.scene_id !== "string") continue;
    let sceneId;
    try {
      sceneId = assertSafeSceneId(scene.scene_id);
    } catch {
      continue;
    }
    const sourceClips = Array.isArray(scene.source_clips) ? scene.source_clips : [];
    for (let clipIndex = 0; clipIndex < sourceClips.length; clipIndex += 1) {
      const clipAbs = transcodedClipPath(id, sceneId, clipIndex);
      const linkName = `${sceneId}-${clipIndex}.mp4`;
      tuples.push({
        scene_id: sceneId,
        clip_index: clipIndex,
        clip_abs: clipAbs,
        link_rel: `${SOURCE_SUBDIR}/${linkName}`,
        link_abs: path.join(linkDir, linkName),
      });
    }
  }
  return tuples;
}

function dedupeBasename(basename, used) {
  if (!used.has(basename)) return basename;
  const ext = path.extname(basename);
  const stem = ext ? basename.slice(0, basename.length - ext.length) : basename;
  let suffix = 1;
  let candidate = `${stem}-${suffix}${ext}`;
  while (used.has(candidate)) {
    suffix += 1;
    candidate = `${stem}-${suffix}${ext}`;
  }
  return candidate;
}

function resolveSourceLinks(projectId) {
  const id = assertSafeProjectId(projectId);
  const manifest = readManifestSafe(id);
  if (!manifest || !Array.isArray(manifest.files)) return [];
  const linkDir = composeSourceDir(id);
  const used = new Set();
  const tuples = [];
  for (let i = 0; i < manifest.files.length; i += 1) {
    const file = manifest.files[i];
    if (!file || typeof file.path !== "string" || !file.path.trim()) continue;
    const rawBasename = path.basename(file.path);
    if (!rawBasename) continue;
    const basename = dedupeBasename(rawBasename, used);
    used.add(basename);
    tuples.push({
      manifest_file_index: i,
      source_abs: file.path,
      link_rel: `${SOURCE_SUBDIR}/${basename}`,
      link_abs: path.join(linkDir, basename),
    });
  }
  return tuples;
}

function recreateSourceSymlinks(projectId, composeRoot) {
  const id = assertSafeProjectId(projectId);
  const manifest = readManifestSafe(id);
  if (!manifest) {
    return { links: [], scene_clip_links: [], warnings: ["manifest not found; no source symlinks created"] };
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { links: [], scene_clip_links: [], warnings: [] };
  }
  const links = resolveSourceLinks(id);
  const sceneClipLinks = resolveSceneClipLinks(id);
  if (links.length === 0 && sceneClipLinks.length === 0) {
    return { links: [], scene_clip_links: [], warnings: [] };
  }

  const linkDir = path.join(composeRoot, SOURCE_SUBDIR);
  fs.mkdirSync(linkDir, { recursive: true });

  const created = [];
  const warnings = [];
  for (const link of links) {
    if (!fs.existsSync(link.source_abs)) {
      warnings.push(`source missing on disk: ${link.source_abs}`);
      continue;
    }
    try {
      try {
        fs.unlinkSync(link.link_abs);
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
      // Symlinks on darwin/linux follow the target on read; no `type` arg needed.
      fs.symlinkSync(link.source_abs, link.link_abs);
      created.push(link);
    } catch (err) {
      if (err && (err.code === "EPERM" || err.code === "EACCES")) {
        warnings.push(
          `could not create symlink for ${path.basename(link.source_abs)}: ${err.code}`,
        );
        continue;
      }
      throw err;
    }
  }

  // Scene-clip symlinks: <composeRoot>/source/<scene_id>.mp4 → <session>/transcoded/clips/<scene_id>.mp4.
  // The composer references these directly (./source/s001.mp4) instead of seeking
  // into the original source with #t= fragments or `currentTime`, both of which
  // are unreliable in headless Chrome on large or HEVC sources. Materialization
  // happens at STORYBOARD -> COMPOSE; if a scene's clip is missing here we warn
  // (don't fail) because save-composition is also called on raw compose authoring
  // and the gate already blocks PREVIEW until clips resolve.
  const sceneClipsCreated = [];
  for (const link of sceneClipLinks) {
    if (!fs.existsSync(link.clip_abs)) {
      warnings.push(`scene clip missing on disk for ${link.scene_id}-${link.clip_index}: ${link.clip_abs}`);
      continue;
    }
    try {
      try {
        fs.unlinkSync(link.link_abs);
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
      fs.symlinkSync(link.clip_abs, link.link_abs);
      sceneClipsCreated.push(link);
    } catch (err) {
      if (err && (err.code === "EPERM" || err.code === "EACCES")) {
        warnings.push(
          `could not create scene-clip symlink for ${link.scene_id}-${link.clip_index}: ${err.code}`,
        );
        continue;
      }
      throw err;
    }
  }
  return { links: created, scene_clip_links: sceneClipsCreated, warnings };
}

module.exports = {
  SOURCE_SUBDIR,
  recreateSourceSymlinks,
  resolveSceneClipLinks,
  resolveSourceLinks,
};
