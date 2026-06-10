"use strict";

// Single source of truth for platform geometry/pacing defaults (D3). Free-text
// platform answers canonicalize through the alias table; unrecognized input
// falls back to the generic `vertical` profile (never an error). Optional user
// override file <repo>/.vob-config/render-profiles.json shallow-merges over the
// built-ins (this module absorbed package-output's old thumbnail-percent
// reader). Downstream consumers read the STORED profile snapshot from the
// intent answer — do not re-resolve free text outside record time.

const fs = require("fs");
const path = require("path");

const PLATFORM_PROFILES = Object.freeze({
  tiktok: {
    width: 1080, height: 1920, aspect: "9:16", fps: 30,
    safe_top_px: 200, safe_bottom_px: 280,
    ideal_duration_s: { min: 15, max: 45 }, max_duration_s: 90,
    caption_defaults: { anchor: "bottom", offset_px: 300, min_font_px: 56, max_words_per_line: 4 },
    thumbnail_timestamp_percent: 10,
  },
  reels: {
    width: 1080, height: 1920, aspect: "9:16", fps: 30,
    safe_top_px: 220, safe_bottom_px: 270,
    ideal_duration_s: { min: 15, max: 45 }, max_duration_s: 90,
    caption_defaults: { anchor: "bottom", offset_px: 300, min_font_px: 56, max_words_per_line: 4 },
    thumbnail_timestamp_percent: 10,
  },
  shorts: {
    width: 1080, height: 1920, aspect: "9:16", fps: 30,
    safe_top_px: 120, safe_bottom_px: 220,
    ideal_duration_s: { min: 20, max: 50 }, max_duration_s: 60,
    caption_defaults: { anchor: "bottom", offset_px: 260, min_font_px: 56, max_words_per_line: 4 },
    thumbnail_timestamp_percent: 10,
  },
  // generic 9:16 fallback for unrecognized platforms
  vertical: {
    width: 1080, height: 1920, aspect: "9:16", fps: 30,
    safe_top_px: 200, safe_bottom_px: 250,
    ideal_duration_s: { min: 15, max: 60 }, max_duration_s: null,
    caption_defaults: { anchor: "bottom", offset_px: 280, min_font_px: 56, max_words_per_line: 4 },
    thumbnail_timestamp_percent: 10,
  },
  youtube: {
    width: 1920, height: 1080, aspect: "16:9", fps: 30,
    safe_top_px: 80, safe_bottom_px: 140,
    ideal_duration_s: { min: 30, max: 180 }, max_duration_s: null,
    caption_defaults: { anchor: "bottom", offset_px: 140, min_font_px: 36, max_words_per_line: 7 },
    thumbnail_timestamp_percent: 15,
  },
  landscape: {
    width: 1920, height: 1080, aspect: "16:9", fps: 30,
    safe_top_px: 80, safe_bottom_px: 120,
    ideal_duration_s: { min: 15, max: 120 }, max_duration_s: null,
    caption_defaults: { anchor: "bottom", offset_px: 140, min_font_px: 36, max_words_per_line: 7 },
    thumbnail_timestamp_percent: 15,
  },
  square: {
    width: 1080, height: 1080, aspect: "1:1", fps: 30,
    safe_top_px: 100, safe_bottom_px: 150,
    ideal_duration_s: { min: 15, max: 60 }, max_duration_s: 120,
    caption_defaults: { anchor: "bottom", offset_px: 160, min_font_px: 48, max_words_per_line: 5 },
    thumbnail_timestamp_percent: 15,
  },
});

const PLATFORM_ALIASES = Object.freeze({
  "tiktok": "tiktok", "tik tok": "tiktok", "tik-tok": "tiktok", "tt": "tiktok", "douyin": "tiktok",
  "reels": "reels", "reel": "reels", "instagram": "reels", "instagram reels": "reels",
  "ig": "reels", "ig reels": "reels", "insta": "reels",
  "shorts": "shorts", "short": "shorts", "youtube shorts": "shorts", "yt shorts": "shorts", "ytshorts": "shorts",
  "youtube": "youtube", "yt": "youtube", "long-form": "youtube", "longform": "youtube",
  "landscape": "landscape", "horizontal": "landscape", "16:9": "landscape", "widescreen": "landscape",
  "square": "square", "1:1": "square", "instagram feed": "square", "feed": "square",
  "vertical": "vertical", "portrait": "vertical", "9:16": "vertical",
  "story": "vertical", "stories": "vertical", "instagram story": "vertical",
  "snapchat": "vertical", "facebook reels": "vertical", "fb reels": "vertical",
});

// platform-profiles.js sits at mcp/lib/, so two ".." reach the repo root
// (package-output.js used three from mcp/lib/tools/).
const OVERRIDE_PATH = path.join(path.resolve(__dirname, "..", ".."), ".vob-config", "render-profiles.json");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Shallow merge with one-level-deep merging for the two nested blocks;
// scalars replace.
function mergeProfile(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if ((key === "caption_defaults" || key === "ideal_duration_s") && isPlainObject(value) && isPlainObject(base[key])) {
      merged[key] = Object.freeze({ ...base[key], ...value });
    } else {
      merged[key] = value;
    }
  }
  return Object.freeze(merged);
}

function readOverrideFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OVERRIDE_PATH, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    // Unreadable/malformed -> built-ins, no warning (same forgiveness as the
    // old package-output reader).
    return null;
  }
}

function buildEffectiveTable(override) {
  const profiles = { ...PLATFORM_PROFILES };
  const aliases = { ...PLATFORM_ALIASES };
  let topThumbnailPercent = null;
  if (isPlainObject(override)) {
    if (Number.isFinite(override.thumbnail_timestamp_percent)) {
      topThumbnailPercent = override.thumbnail_timestamp_percent;
    }
    for (const [rawKey, value] of Object.entries(override)) {
      if (rawKey === "thumbnail_timestamp_percent") continue;
      if (!isPlainObject(value)) continue;
      const name = String(rawKey).toLowerCase().trim();
      if (!name) continue;
      if (Object.prototype.hasOwnProperty.call(PLATFORM_PROFILES, name)) {
        profiles[name] = mergeProfile(PLATFORM_PROFILES[name], value);
      } else if (Number.isFinite(value.width) && Number.isFinite(value.height)) {
        // New canonical platform: portrait defaults from `vertical`, else
        // `landscape`. It also becomes its own alias. Aliases are NOT
        // user-extendable beyond that in v2.
        const base = value.height > value.width ? PLATFORM_PROFILES.vertical : PLATFORM_PROFILES.landscape;
        profiles[name] = mergeProfile(base, value);
        aliases[name] = name;
      }
    }
  }
  // Longest-first so the word-boundary scan prefers the most specific alias
  // ("youtube shorts" before "youtube").
  const aliasesByLength = Object.keys(aliases).sort((a, b) => b.length - a.length);
  return { profiles, aliases, aliasesByLength, topThumbnailPercent };
}

// Override file read lazily once per process.
let cachedTable = null;

function effectiveTable() {
  if (!cachedTable) {
    cachedTable = buildEffectiveTable(readOverrideFile());
  }
  return cachedTable;
}

function _reloadForTests() {
  cachedTable = null;
}

// Never throws; `raw` is preserved verbatim (original casing/whitespace).
function canonicalizePlatform(raw) {
  const rawStr = typeof raw === "string" ? raw : (raw == null ? "" : String(raw));
  const norm = rawStr.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,!?]+$/, "");
  const table = effectiveTable();
  if (Object.prototype.hasOwnProperty.call(table.aliases, norm)) {
    return { raw: rawStr, canonical: table.aliases[norm], recognized: true };
  }
  // Word-boundary scan handles answers like "for tiktok mainly".
  for (const alias of table.aliasesByLength) {
    if (new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(norm)) {
      return { raw: rawStr, canonical: table.aliases[alias], recognized: true };
    }
  }
  return { raw: rawStr, canonical: "vertical", recognized: false };
}

// Merged with user override; unknown name -> vertical profile.
function getPlatformProfile(canonical) {
  const table = effectiveTable();
  const name = typeof canonical === "string" ? canonical.toLowerCase().trim() : "";
  if (Object.prototype.hasOwnProperty.call(table.profiles, name)) {
    return table.profiles[name];
  }
  return table.profiles.vertical;
}

function resolvePlatform(raw) {
  const { raw: rawStr, canonical, recognized } = canonicalizePlatform(raw);
  return { raw: rawStr, canonical, recognized, profile: getPlatformProfile(canonical) };
}

function thumbnailTimestampPercent(canonical) {
  const profile = getPlatformProfile(canonical);
  if (profile && Number.isFinite(profile.thumbnail_timestamp_percent)) {
    return profile.thumbnail_timestamp_percent;
  }
  const table = effectiveTable();
  if (Number.isFinite(table.topThumbnailPercent)) {
    return table.topThumbnailPercent;
  }
  return 10;
}

// Rules 2-6 of parseDurationToSeconds, applied to one side (or the whole).
function parseSingleDuration(input) {
  const s = String(input).trim();
  let m = s.match(/^(\d+):([0-5]?\d)$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?$/);
  if (m) return Number(m[1]) * 60;
  m = s.match(/^(\d+(?:\.\d+)?)\s*s(?:ec(?:ond)?s?)?$/);
  if (m) return Number(m[1]);
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  return null;
}

function clampDuration(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  return rounded > 0 ? rounded : null;
}

// "90", "1:30", "1m 30s", "90 seconds", "~1m", "30-45s" (midpoint) -> seconds.
// Unparseable -> null (downstream treats null as "target unknown").
function parseDurationToSeconds(raw) {
  let text = null;
  if (typeof raw === "string") text = raw;
  else if (typeof raw === "number" && Number.isFinite(raw)) text = String(raw);
  if (text === null) return null;
  let norm = text.toLowerCase().trim();
  norm = norm.replace(/^~\s*/, "").replace(/^(?:about|around|roughly)\s+/, "").trim();
  const range = norm.match(/^(.+?)\s*(?:[–—-]|\bto\b)\s*(.+)$/);
  if (range) {
    const a = parseSingleDuration(range[1]);
    const b = parseSingleDuration(range[2]);
    if (a !== null && b !== null) return clampDuration(Math.round((a + b) / 2));
  }
  return clampDuration(parseSingleDuration(norm));
}

module.exports = {
  PLATFORM_ALIASES,
  PLATFORM_PROFILES,
  _reloadForTests,
  canonicalizePlatform,
  getPlatformProfile,
  parseDurationToSeconds,
  resolvePlatform,
  thumbnailTimestampPercent,
};
