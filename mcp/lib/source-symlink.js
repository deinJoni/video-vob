"use strict";

const fs = require("fs");
const path = require("path");

const { manifestPath, composeSourceDir, assertSafeProjectId } = require("./paths.js");

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
    return { links: [], warnings: ["manifest not found; no source symlinks created"] };
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    return { links: [], warnings: [] };
  }
  const links = resolveSourceLinks(id);
  if (links.length === 0) return { links: [], warnings: [] };

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
  return { links: created, warnings };
}

module.exports = {
  SOURCE_SUBDIR,
  resolveSourceLinks,
  recreateSourceSymlinks,
};
