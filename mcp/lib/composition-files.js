"use strict";

const path = require("path");

const MAX_FILES = 64;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_AGGREGATE_BYTES = 1 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".html", ".css", ".js", ".json", ".svg"]);
const REQUIRED_FILES = ["index.html"];

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function containsUnsafePathSegment(relPath) {
  if (relPath.length === 0) return true;
  if (relPath.includes("\\")) return true;
  if (relPath.startsWith("/")) return true;
  if (relPath.startsWith("./") || relPath === ".") return true;
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return true;
    if (segment.startsWith(".") && segment !== ".") {
      // Disallow dotfiles like .env, .git, etc. — keeps the surface tiny.
      return true;
    }
  }
  return false;
}

function validateCompositionFiles(files) {
  const errors = [];
  const normalized = [];

  if (!isPlainObject(files)) {
    return { ok: false, errors: ["files must be a non-array object mapping relative paths to string contents"], normalized: [] };
  }

  const keys = Object.keys(files);
  if (keys.length === 0) {
    errors.push("files must contain at least one entry");
  }
  if (keys.length > MAX_FILES) {
    errors.push(`files contains ${keys.length} entries; maximum is ${MAX_FILES}`);
  }

  let aggregate = 0;
  for (const key of keys) {
    if (typeof key !== "string" || key.length === 0) {
      errors.push(`file path must be a non-empty string (got ${JSON.stringify(key)})`);
      continue;
    }

    if (containsUnsafePathSegment(key)) {
      errors.push(`file path contains unsafe segment(s): ${JSON.stringify(key)}`);
      continue;
    }

    const ext = path.extname(key).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      errors.push(`file path has disallowed extension (allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}): ${key}`);
      continue;
    }

    const content = files[key];
    if (typeof content !== "string") {
      errors.push(`file content must be a string for ${key}`);
      continue;
    }

    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > MAX_FILE_BYTES) {
      errors.push(`file ${key} is ${byteLength} bytes; maximum is ${MAX_FILE_BYTES}`);
      continue;
    }

    aggregate += byteLength;
    normalized.push({ relPath: key, content, byteLength });
  }

  if (aggregate > MAX_AGGREGATE_BYTES) {
    errors.push(`aggregate file size is ${aggregate} bytes; maximum is ${MAX_AGGREGATE_BYTES}`);
  }

  for (const required of REQUIRED_FILES) {
    if (!keys.includes(required)) {
      errors.push(`required file missing: ${required}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, normalized: [] };
  }

  normalized.sort((a, b) => a.relPath.localeCompare(b.relPath));

  return { ok: true, errors: [], normalized, total_bytes: aggregate };
}

// The exact `files` input composition-qc consumes at save time: the validator's
// `normalized` array filtered to .html/.css. Keeps the QC module free of
// validator coupling — lint-time callers build the same shape from disk.
function htmlAndCssEntries(normalized) {
  return (Array.isArray(normalized) ? normalized : [])
    .filter((entry) => entry && /\.(html|css)$/i.test(entry.relPath))
    .map((entry) => ({ relPath: entry.relPath, content: entry.content }));
}

module.exports = {
  ALLOWED_EXTENSIONS,
  MAX_AGGREGATE_BYTES,
  MAX_FILES,
  MAX_FILE_BYTES,
  REQUIRED_FILES,
  htmlAndCssEntries,
  validateCompositionFiles,
};
