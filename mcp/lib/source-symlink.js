"use strict";

const fs = require("fs");
const path = require("path");

const { allStoryboardScenes, collectSubjectPlacements } = require("./storyboard-schema.js");
const {
  assertSafeProjectId,
  assertSafeSceneId,
  composeSourceDir,
  manifestPath,
  mattePath,
  storyboardPath,
  transcodedClipPath,
} = require("./paths.js");

const SOURCE_SUBDIR = "source";

const FONT_ASSETS_DIR = path.resolve(__dirname, "..", "assets", "fonts");
const FONT_CSS_SRC = path.resolve(__dirname, "..", "assets", "fonts.css");
const CAPTION_ASSETS_DIR = path.resolve(__dirname, "..", "assets", "captions");

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
  if (!sb) return [];
  // Union across timelines: in fan-out every short's clips are materialized,
  // so every short's clips get a ./source/ symlink.
  const scenes = allStoryboardScenes(sb);
  if (scenes.length === 0) return [];
  const linkDir = composeSourceDir(id);
  const tuples = [];
  for (const scene of scenes) {
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

// Subject-matte symlinks (v3.3): compose/source/<scene_id>-<clipIndex>.webm ->
// <session>/transcoded/mattes/<scene_id>-<clipIndex>.webm, for every
// render_mode:"subject" placement. The composer references the matte as
// ./source/<scene_id>-<clipIndex>.webm (an alpha <video> over the backdrop) with
// the subject's AUDIO from the sibling .mp4 clip. Driven by the storyboard's
// subject placements (mirrors resolveSceneClipLinks); a missing matte warns, not
// fails — a matte can legitimately be absent (the COMPOSE-entry materializer
// degrades on a missing model/failed inference), in which case the composer
// falls back to a rectangular pip.
function resolveMatteLinks(projectId) {
  const id = assertSafeProjectId(projectId);
  const sb = readStoryboardSafe(id);
  if (!sb) return [];
  const placements = collectSubjectPlacements(sb);
  if (placements.length === 0) return [];
  const linkDir = composeSourceDir(id);
  const tuples = [];
  const seen = new Set();
  for (const p of placements) {
    if (typeof p.scene_id !== "string" || !Number.isInteger(p.clip_index) || p.clip_index < 0) continue;
    let sceneId;
    try {
      sceneId = assertSafeSceneId(p.scene_id);
    } catch {
      continue;
    }
    const key = `${sceneId}-${p.clip_index}`;
    if (seen.has(key)) continue; // one symlink per unique matte
    seen.add(key);
    const linkName = `${key}.webm`;
    tuples.push({
      scene_id: sceneId,
      clip_index: p.clip_index,
      matte_abs: mattePath(id, sceneId, p.clip_index),
      link_rel: `${SOURCE_SUBDIR}/${linkName}`,
      link_abs: path.join(linkDir, linkName),
    });
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
    return { links: [], scene_clip_links: [], matte_links: [], warnings: ["manifest not found; no source symlinks created"] };
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { links: [], scene_clip_links: [], matte_links: [], warnings: [] };
  }
  const links = resolveSourceLinks(id);
  const sceneClipLinks = resolveSceneClipLinks(id);
  const matteLinks = resolveMatteLinks(id);
  if (links.length === 0 && sceneClipLinks.length === 0 && matteLinks.length === 0) {
    return { links: [], scene_clip_links: [], matte_links: [], warnings: [] };
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
  // happens at PLAN -> COMPOSE; if a scene's clip is missing here we warn
  // (don't fail) because save-composition is also called on raw compose authoring
  // — a missing clip here surfaces as a warning, and composition QC
  // (`vob/source_ref_target_missing`, run at save and lint) blocks the pipeline
  // if the composition actually references it.
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

  // Subject-matte symlinks: compose/source/<scene_id>-<clipIndex>.webm. Warn
  // (don't fail) on a missing matte — same posture as the scene-clip symlinks. A
  // composition that actually references a missing matte is caught by composition
  // QC's source-ref check; a degraded/failed matte simply has no symlink and the
  // composer falls back to a rectangular pip.
  const mattesCreated = [];
  for (const link of matteLinks) {
    if (!fs.existsSync(link.matte_abs)) {
      warnings.push(`subject matte missing on disk for ${link.scene_id}-${link.clip_index}: ${link.matte_abs}`);
      continue;
    }
    try {
      try {
        fs.unlinkSync(link.link_abs);
      } catch (err) {
        if (err && err.code !== "ENOENT") throw err;
      }
      fs.symlinkSync(link.matte_abs, link.link_abs);
      mattesCreated.push(link);
    } catch (err) {
      if (err && (err.code === "EPERM" || err.code === "EACCES")) {
        warnings.push(`could not create matte symlink for ${link.scene_id}-${link.clip_index}: ${err.code}`);
        continue;
      }
      throw err;
    }
  }
  return { links: created, scene_clip_links: sceneClipsCreated, matte_links: mattesCreated, warnings };
}

// Inject the vendored font kit into compose/: symlink compose/fonts -> mcp/assets/fonts
// (same mechanism as ./source/ — hyperframes' file server follows symlinks; the
// scene-clip symlinks prove it on every render today) and COPY fonts.css to
// compose/fonts.css (tiny; keeps url("./fonts/...") resolution trivial).
// Graceful when assets are absent: warn + return linked:false — compositions
// fall back to system fonts; QC does not enforce font usage.
function injectFontKit(composeRoot, { skipCss = false } = {}) {
  const warnings = [];
  const linkAbs = path.join(composeRoot, "fonts");
  if (!fs.existsSync(FONT_ASSETS_DIR)) {
    return { linked: false, warnings: [`font kit not found at ${FONT_ASSETS_DIR}; compositions fall back to system fonts`] };
  }
  try {
    let st = null;
    try { st = fs.lstatSync(linkAbs); } catch {}
    if (st && st.isSymbolicLink()) fs.unlinkSync(linkAbs);
    else if (st) {
      // composer wrote real files under fonts/ — respect them, skip the kit dir
      warnings.push("compose/fonts exists as a real directory (composer-supplied); font kit dir not linked");
      return { linked: false, warnings };
    }
    fs.symlinkSync(FONT_ASSETS_DIR, linkAbs);
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "EACCES")) {
      warnings.push(`could not link font kit: ${err.code}`);
      return { linked: false, warnings };
    }
    throw err;
  }
  if (!skipCss) {
    try {
      fs.copyFileSync(FONT_CSS_SRC, path.join(composeRoot, "fonts.css"));
    } catch {
      warnings.push(`fonts.css missing at ${FONT_CSS_SRC}; linked fonts/ without a stylesheet`);
    }
  }
  return { linked: true, warnings };
}

// Inject the vendored caption-component kit into compose/: symlink
// compose/captions -> mcp/assets/captions (same mechanism as ./source/ and
// ./fonts/). The composer READS ./captions/manifest.json + the per-component
// reference HTML (./captions/<name>/<name>.html), then authors its OWN caption
// markup adapting the vetted technique — nothing here is rendered directly
// (hyperframes renders index.html; an unreferenced symlinked dir is inert). No
// CSS copy is needed (the manifest is read, not url()-resolved). Graceful: warn
// + linked:false if assets are absent or the composer wrote its own captions/.
function injectCaptionKit(composeRoot, { skip = false } = {}) {
  if (skip) return { linked: false, warnings: [] };
  const warnings = [];
  const linkAbs = path.join(composeRoot, "captions");
  if (!fs.existsSync(CAPTION_ASSETS_DIR)) {
    return { linked: false, warnings: [`caption kit not found at ${CAPTION_ASSETS_DIR}; the composer authors captions unaided`] };
  }
  try {
    let st = null;
    try { st = fs.lstatSync(linkAbs); } catch {}
    if (st && st.isSymbolicLink()) fs.unlinkSync(linkAbs);
    else if (st) {
      // composer wrote real files under captions/ — respect them, skip the kit dir
      warnings.push("compose/captions exists as a real directory (composer-supplied); caption kit dir not linked");
      return { linked: false, warnings };
    }
    fs.symlinkSync(CAPTION_ASSETS_DIR, linkAbs);
  } catch (err) {
    if (err && (err.code === "EPERM" || err.code === "EACCES")) {
      warnings.push(`could not link caption kit: ${err.code}`);
      return { linked: false, warnings };
    }
    throw err;
  }
  return { linked: true, warnings };
}

module.exports = {
  SOURCE_SUBDIR,
  injectFontKit,
  injectCaptionKit,
  recreateSourceSymlinks,
  resolveMatteLinks,
  resolveSceneClipLinks,
  resolveSourceLinks,
};
