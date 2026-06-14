"use strict";

// Video-type presets (v3 P1) — the single source of truth for "what kind of
// video is this?". A preset bundles the format default, editorial behavior
// (clean-cut on/off), the plan-lint ruleset, the overlay vocabulary the
// composer may draw from, and the render segmentation policy. Generalization
// happens via this DATA, not via `if (videoType === ...)` branches in handlers.
//
// Resolution of the ACTIVE type is late-bound through ONE function,
// resolveActiveVideoType(state):
//   1. VOB_VIDEO_TYPE env var          (per-process override)
//   2. recorded `video_type` intent answer (canonical when recognized)
//   3. derived from the canonical platform + target duration
//   4. "social-short"                  (byte-for-byte v2.1 behavior)
//
// User presets: <repo>/.vob-config/video-types.json shallow-merges over the
// built-ins (one-level-deep for `editorial`/`render`; scalars replace; unknown
// names become new presets based on `general`). An unknown preset NAME always
// falls back to `general` — never an error (same forgiveness as the platform
// alias table). VOB_VIDEO_TYPES_FILE overrides the config path (tests/installs).

const fs = require("fs");
const path = require("path");

const { canonicalizePlatform, getPlatformProfile } = require("./platform-profiles.js");

// The full composer-coded overlay vocabulary (P3 renders these; the preset's
// `overlay_vocabulary` is the subset that fits the format).
const OVERLAY_TYPES = Object.freeze([
  "title_card",
  "lower_third",
  "callout",
  "kinetic_caption",
  "caption_block",
  "logo_bug",
  "progress_bar",
  "chapter_marker",
  "section_title",
  "data_viz",
  "cta",
  "end_card",
  "pip",
]);

// Plan-lint rulesets: per-rule disable sets + the chaptered extras flag.
// `retention` is the v2.1 behavior (hook-first heuristics ON).
// PLAN_RHYTHM_ARC_INVERTED is a retention heuristic too — front-loading the
// energy is a short-form rule; cinematic/long-form legitimately BUILD to a
// climax, so the non-retention rulesets disable it (same gating as the hook
// rules). PLAN_PACING_MONOTONE stays on everywhere (an all-identical pacing
// track reads flat in any format).
const LINT_RULESETS = Object.freeze({
  retention: Object.freeze({ disabled_rules: Object.freeze([]), chapter_rules: false }),
  chaptered: Object.freeze({
    disabled_rules: Object.freeze(["PLAN_HOOK_NOT_FIRST", "PLAN_HOOK_TOO_LONG", "PLAN_RHYTHM_ARC_INVERTED"]),
    chapter_rules: true,
  }),
  montage: Object.freeze({
    disabled_rules: Object.freeze(["PLAN_HOOK_NOT_FIRST", "PLAN_HOOK_TOO_LONG", "PLAN_RHYTHM_ARC_INVERTED"]),
    chapter_rules: false,
  }),
  general: Object.freeze({
    disabled_rules: Object.freeze(["PLAN_HOOK_NOT_FIRST", "PLAN_HOOK_TOO_LONG", "PLAN_RHYTHM_ARC_INVERTED"]),
    chapter_rules: false,
  }),
});

const SEGMENTATION_MODES = Object.freeze(["single", "auto", "manual"]);

const BUILT_IN_VIDEO_TYPES = Object.freeze({
  // v2.1 short-form, byte-for-byte: retention lint, clean-cut on, one
  // continuous composition.
  "social-short": Object.freeze({
    platform_default: "tiktok",
    editorial: Object.freeze({ clean_cut: true, scene_detect: true }),
    lint_ruleset: "retention",
    overlay_vocabulary: Object.freeze([
      "kinetic_caption", "caption_block", "title_card", "lower_third", "logo_bug", "cta", "end_card",
    ]),
    render: Object.freeze({ segmentation: "single" }),
    design_default: Object.freeze({
      caption_style: "bold-pop", motion: "fast-snap", grade: "high-contrast",
      typography: Object.freeze({ headline: "Anton", caption: "Inter", body: "Inter" }),
      palette: Object.freeze({ bg: "#000000", text: "#FFFFFF", accent: "#FF3B30" }),
    }),
  }),
  "long-form": Object.freeze({
    platform_default: "youtube_long",
    editorial: Object.freeze({ clean_cut: true, scene_detect: true }),
    lint_ruleset: "chaptered",
    overlay_vocabulary: Object.freeze([
      "chapter_marker", "section_title", "lower_third", "callout", "data_viz",
      "progress_bar", "caption_block", "logo_bug", "cta", "end_card", "pip",
    ]),
    render: Object.freeze({ segmentation: "auto" }),
    design_default: Object.freeze({
      caption_style: "clean-pill", motion: "medium-soft", grade: "none",
      typography: Object.freeze({ headline: "Hanken Grotesk", caption: "Inter", body: "Inter" }),
      palette: Object.freeze({ bg: "#0A0A0A", text: "#F5F5F0", accent: "#3B82F6" }),
    }),
  }),
  cinematic: Object.freeze({
    platform_default: "cinematic",
    // No filler/dead-air surgery on a montage — pacing is the edit.
    editorial: Object.freeze({ clean_cut: false, scene_detect: true }),
    lint_ruleset: "montage",
    overlay_vocabulary: Object.freeze(["title_card", "section_title", "caption_block", "end_card"]),
    render: Object.freeze({ segmentation: "auto" }),
    design_default: Object.freeze({
      caption_style: "minimal-lower-third", motion: "slow-cinematic", grade: "desaturated",
      typography: Object.freeze({ headline: "Playfair Display", caption: "Inter", body: "EB Garamond" }),
      palette: Object.freeze({ bg: "#000000", text: "#F2EFE8", accent: "#C9A227" }),
    }),
  }),
  tutorial: Object.freeze({
    platform_default: "tutorial",
    editorial: Object.freeze({ clean_cut: true, scene_detect: true }),
    lint_ruleset: "chaptered",
    overlay_vocabulary: Object.freeze([
      "callout", "chapter_marker", "section_title", "title_card", "caption_block",
      "progress_bar", "pip", "data_viz", "cta", "end_card",
    ]),
    render: Object.freeze({ segmentation: "auto" }),
    design_default: Object.freeze({
      caption_style: "clean-pill", motion: "medium-soft", grade: "none",
      typography: Object.freeze({ headline: "Inter", caption: "Inter", body: "Inter" }),
      palette: Object.freeze({ bg: "#0B0B0C", text: "#F5F5F0", accent: "#22C55E" }),
    }),
  }),
  podcast: Object.freeze({
    platform_default: "youtube_long",
    // Long static shots: scene detection contributes nothing (skippable at
    // INSPECT); clean-cut still helps a rambling conversation.
    editorial: Object.freeze({ clean_cut: true, scene_detect: false }),
    lint_ruleset: "chaptered",
    overlay_vocabulary: Object.freeze([
      "chapter_marker", "lower_third", "caption_block", "data_viz",
      "logo_bug", "progress_bar", "end_card", "pip",
    ]),
    render: Object.freeze({ segmentation: "auto" }),
    design_default: Object.freeze({
      caption_style: "minimal-lower-third", motion: "medium-soft", grade: "none",
      typography: Object.freeze({ headline: "Hanken Grotesk", caption: "Inter", body: "Inter" }),
      palette: Object.freeze({ bg: "#111111", text: "#F5F5F0", accent: "#8B5CF6" }),
    }),
  }),
  // The generalized default an unknown preset name falls back to.
  general: Object.freeze({
    platform_default: "landscape",
    editorial: Object.freeze({ clean_cut: true, scene_detect: true }),
    lint_ruleset: "general",
    overlay_vocabulary: OVERLAY_TYPES,
    render: Object.freeze({ segmentation: "auto" }),
    design_default: Object.freeze({
      caption_style: "clean-pill", motion: "medium-soft", grade: "none",
      typography: Object.freeze({ headline: "Inter", caption: "Inter", body: "Inter" }),
      palette: Object.freeze({ bg: "#000000", text: "#FFFFFF", accent: "#3B82F6" }),
    }),
  }),
});

const VIDEO_TYPE_ALIASES = Object.freeze({
  "social-short": "social-short", "social short": "social-short", "short": "social-short",
  "shorts": "social-short", "short-form": "social-short", "shortform": "social-short",
  "short form": "social-short", "social": "social-short", "reel": "social-short",
  "long-form": "long-form", "longform": "long-form", "long form": "long-form", "long": "long-form",
  "documentary": "long-form", "vlog": "long-form", "video essay": "long-form", "essay": "long-form",
  "cinematic": "cinematic", "film": "cinematic", "movie": "cinematic", "montage": "cinematic",
  "short film": "cinematic",
  "tutorial": "tutorial", "screencast": "tutorial", "how-to": "tutorial", "howto": "tutorial",
  "how to": "tutorial", "walkthrough": "tutorial", "demo": "tutorial", "course": "tutorial",
  "podcast": "podcast", "interview": "podcast", "talk": "podcast", "conversation": "podcast",
  "general": "general",
});

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// video-types.js sits at mcp/lib/, so two ".." reach the repo/install root
// (same anchor as render-profiles.json / host.json).
const DEFAULT_OVERRIDE_PATH = path.join(path.resolve(__dirname, "..", ".."), ".vob-config", "video-types.json");

function overridePath() {
  const env = (process.env.VOB_VIDEO_TYPES_FILE || "").trim();
  return env || DEFAULT_OVERRIDE_PATH;
}

function readOverrideFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(overridePath(), "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null; // absent/malformed -> built-ins, silently (mirrors siblings)
  }
}

function normalizeRuleset(value, fallback) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(LINT_RULESETS, value)
    ? value
    : fallback;
}

function normalizeSegmentation(value, fallback) {
  return typeof value === "string" && SEGMENTATION_MODES.includes(value) ? value : fallback;
}

// Merge one user preset over a base: one-level-deep for editorial/render,
// scalars replace, overlay_vocabulary replaces wholesale (filtered to known
// types so a typo'd vocabulary entry can't reach the composer contract).
function mergePreset(base, override) {
  const merged = { ...base };
  if (typeof override.platform_default === "string" && override.platform_default.trim()) {
    merged.platform_default = override.platform_default.trim().toLowerCase();
  }
  if (isPlainObject(override.editorial)) {
    merged.editorial = Object.freeze({ ...base.editorial, ...override.editorial });
  }
  if (isPlainObject(override.render)) {
    merged.render = Object.freeze({
      ...base.render,
      ...override.render,
      segmentation: normalizeSegmentation(override.render.segmentation, base.render.segmentation),
    });
  }
  if ("lint_ruleset" in override) {
    merged.lint_ruleset = normalizeRuleset(override.lint_ruleset, base.lint_ruleset);
  }
  if (Array.isArray(override.overlay_vocabulary)) {
    const filtered = override.overlay_vocabulary.filter((t) => OVERLAY_TYPES.includes(t));
    if (filtered.length > 0) merged.overlay_vocabulary = Object.freeze(filtered);
  }
  // design_default: scalars (caption_style/motion/grade) replace; palette and
  // typography deep-merge one level so a user preset can tweak just the accent
  // without redeclaring the whole block. base.design_default always exists
  // (every built-in carries one); a user preset that omits it inherits via the
  // `...base` spread above.
  if (isPlainObject(override.design_default)) {
    const baseD = isPlainObject(base.design_default) ? base.design_default : {};
    const ovD = override.design_default;
    merged.design_default = Object.freeze({
      ...baseD,
      ...ovD,
      palette: Object.freeze({ ...(isPlainObject(baseD.palette) ? baseD.palette : {}), ...(isPlainObject(ovD.palette) ? ovD.palette : {}) }),
      typography: Object.freeze({ ...(isPlainObject(baseD.typography) ? baseD.typography : {}), ...(isPlainObject(ovD.typography) ? ovD.typography : {}) }),
    });
  }
  return Object.freeze(merged);
}

function buildEffectiveTable(override) {
  const presets = { ...BUILT_IN_VIDEO_TYPES };
  const aliases = { ...VIDEO_TYPE_ALIASES };
  const userNames = [];
  if (isPlainObject(override)) {
    for (const [rawKey, value] of Object.entries(override)) {
      if (!isPlainObject(value)) continue;
      const name = String(rawKey).toLowerCase().trim();
      if (!name || name.startsWith("_")) continue; // _comment-style keys skipped
      const base = Object.prototype.hasOwnProperty.call(BUILT_IN_VIDEO_TYPES, name)
        ? BUILT_IN_VIDEO_TYPES[name]
        : BUILT_IN_VIDEO_TYPES.general; // new names start from the generalized default
      presets[name] = mergePreset(base, value);
      aliases[name] = name; // a user preset is its own alias
      userNames.push(name);
    }
  }
  const aliasesByLength = Object.keys(aliases).sort((a, b) => b.length - a.length);
  return { presets, aliases, aliasesByLength, userNames };
}

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

// Never throws. Unrecognized input -> { canonical: null, recognized: false }:
// resolution then FALLS THROUGH to derivation instead of pinning a wrong
// preset (unlike platforms, where geometry must resolve to something).
function canonicalizeVideoType(raw) {
  const rawStr = typeof raw === "string" ? raw : (raw == null ? "" : String(raw));
  const norm = rawStr.toLowerCase().trim().replace(/\s+/g, " ").replace(/[.,!?]+$/, "");
  const table = effectiveTable();
  if (Object.prototype.hasOwnProperty.call(table.aliases, norm)) {
    return { raw: rawStr, canonical: table.aliases[norm], recognized: true };
  }
  for (const alias of table.aliasesByLength) {
    if (new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(norm)) {
      return { raw: rawStr, canonical: table.aliases[alias], recognized: true };
    }
  }
  return { raw: rawStr, canonical: null, recognized: false };
}

// Unknown/null name -> the generalized default, never an error.
function getVideoTypePreset(canonical) {
  const table = effectiveTable();
  const name = typeof canonical === "string" ? canonical.toLowerCase().trim() : "";
  if (Object.prototype.hasOwnProperty.call(table.presets, name)) {
    return table.presets[name];
  }
  return table.presets.general;
}

// --- derivation from platform + duration -------------------------------------

const SHORT_FORM_PLATFORMS = new Set(["tiktok", "reels", "shorts", "vertical", "square"]);
const LONG_FORM_THRESHOLD_S = 180;

// Inputs are the STORED intent answer shapes (canonical platform string, the
// profile snapshot when present, seconds + optional range). Pure.
function deriveVideoType({ platformCanonical = null, platformProfile = null, durationSeconds = null, durationRange = null } = {}) {
  const platform = typeof platformCanonical === "string" ? platformCanonical.toLowerCase().trim() : "";
  if (platform === "cinematic") return "cinematic";
  if (platform === "tutorial") return "tutorial";
  if (platform === "youtube_long") return "long-form";
  if (SHORT_FORM_PLATFORMS.has(platform)) return "social-short";

  const maxSeconds = durationRange && Number.isFinite(durationRange.max_seconds)
    ? durationRange.max_seconds
    : (Number.isFinite(durationSeconds) ? durationSeconds : null);
  const profile = isPlainObject(platformProfile) ? platformProfile : (platform ? getPlatformProfile(platform) : null);
  const portrait = profile && Number.isFinite(profile.width) && Number.isFinite(profile.height)
    ? profile.height > profile.width
    : null;
  if (portrait === true) return "social-short";
  if (maxSeconds !== null && maxSeconds >= LONG_FORM_THRESHOLD_S) return "long-form";
  return "social-short"; // back-compat default (v2.1 rails)
}

// --- the one resolver ---------------------------------------------------------

function intentAnswers(state) {
  const intent = state && isPlainObject(state.intent) ? state.intent : null;
  return intent && isPlainObject(intent.answers) ? intent.answers : {};
}

function storedVideoTypeCanonical(answers) {
  const value = answers.video_type;
  if (typeof value === "string" && value.trim()) {
    const { canonical } = canonicalizeVideoType(value);
    return canonical;
  }
  if (isPlainObject(value)) {
    if (typeof value.canonical === "string" && value.canonical) return value.canonical;
    // canonical:null stored from an unrecognized answer -> re-canonicalize the
    // raw (a user preset added LATER may now match), else fall through.
    if (typeof value.raw === "string" && value.raw) {
      const { canonical } = canonicalizeVideoType(value.raw);
      return canonical;
    }
  }
  return null;
}

function derivationInputs(answers) {
  const tp = answers.target_platform;
  const platformCanonical = isPlainObject(tp)
    ? (typeof tp.canonical === "string" ? tp.canonical : null)
    : (typeof tp === "string" && tp.trim() ? canonicalizePlatform(tp).canonical : null);
  const platformProfile = isPlainObject(tp) && isPlainObject(tp.profile) ? tp.profile : null;
  const td = answers.target_duration;
  const durationSeconds = isPlainObject(td) && Number.isFinite(td.seconds) ? td.seconds : null;
  const durationRange = isPlainObject(td) && isPlainObject(td.range) ? td.range : null;
  return { platformCanonical, platformProfile, durationSeconds, durationRange };
}

// resolveActiveVideoType(state) -> { canonical, source, preset }
//   source: "env" | "intent" | "derived" | "default"
// `state` may be a full session state or anything carrying intent.answers;
// null/undefined resolves env > default.
function resolveActiveVideoType(state) {
  const env = (process.env.VOB_VIDEO_TYPE || "").trim();
  if (env) {
    const { canonical } = canonicalizeVideoType(env);
    if (canonical) {
      return { canonical, source: "env", preset: getVideoTypePreset(canonical) };
    }
    // Unrecognized env value: ignored (falls through), same forgiveness as an
    // unrecognized intent answer.
  }
  const answers = intentAnswers(state);
  const stored = storedVideoTypeCanonical(answers);
  if (stored) {
    return { canonical: stored, source: "intent", preset: getVideoTypePreset(stored) };
  }
  const inputs = derivationInputs(answers);
  if (inputs.platformCanonical || inputs.durationSeconds !== null || inputs.durationRange) {
    const derived = deriveVideoType(inputs);
    return { canonical: derived, source: "derived", preset: getVideoTypePreset(derived) };
  }
  return { canonical: "social-short", source: "default", preset: getVideoTypePreset("social-short") };
}

// Plan-lint view of the active type: which rules are off, whether the
// chaptered extras run, and whether clean-cut straddle warnings apply.
function activeLintRules(state) {
  const vt = resolveActiveVideoType(state);
  const ruleset = LINT_RULESETS[vt.preset.lint_ruleset] || LINT_RULESETS.retention;
  return {
    video_type: vt.canonical,
    ruleset_name: vt.preset.lint_ruleset,
    disabled: new Set(ruleset.disabled_rules),
    chapter_rules: ruleset.chapter_rules === true,
    clean_cut: vt.preset.editorial.clean_cut === true,
  };
}

// --- introspection (vob_doctor / read_state_summary) --------------------------

function designDigest(preset) {
  const d = isPlainObject(preset.design_default) ? preset.design_default : null;
  if (!d) return null;
  return {
    caption_style: typeof d.caption_style === "string" ? d.caption_style : null,
    motion: typeof d.motion === "string" ? d.motion : null,
    grade: typeof d.grade === "string" ? d.grade : null,
    typography: isPlainObject(d.typography) ? { ...d.typography } : null,
    palette: isPlainObject(d.palette) ? { ...d.palette } : null,
  };
}

function presetDigest(name, preset) {
  return {
    name,
    platform_default: preset.platform_default,
    lint_ruleset: preset.lint_ruleset,
    segmentation: preset.render.segmentation,
    clean_cut: preset.editorial.clean_cut,
    scene_detect: preset.editorial.scene_detect,
    overlay_vocabulary: [...preset.overlay_vocabulary],
    design_default: designDigest(preset),
  };
}

function describeVideoTypes() {
  const table = effectiveTable();
  const env = (process.env.VOB_VIDEO_TYPE || "").trim();
  return {
    config_path: overridePath(),
    config_present: table.userNames.length > 0,
    env_override: env || null,
    built_in: Object.keys(BUILT_IN_VIDEO_TYPES),
    user_defined: table.userNames,
    presets: Object.entries(table.presets).map(([name, preset]) => presetDigest(name, preset)),
  };
}

// Lean per-project digest for read_state_summary.
function summarizeActiveVideoType(state) {
  const vt = resolveActiveVideoType(state);
  return {
    canonical: vt.canonical,
    source: vt.source,
    platform_default: vt.preset.platform_default,
    lint_ruleset: vt.preset.lint_ruleset,
    segmentation: vt.preset.render.segmentation,
    clean_cut: vt.preset.editorial.clean_cut,
    overlay_vocabulary: [...vt.preset.overlay_vocabulary],
    // The format's design tokens — the orchestrator seeds the brief's Design
    // language from these (then adjusts by tone), and the storyboarder mirrors
    // the resolved look into storyboard target.design.
    design_default: designDigest(vt.preset),
  };
}

module.exports = {
  BUILT_IN_VIDEO_TYPES,
  LINT_RULESETS,
  OVERLAY_TYPES,
  SEGMENTATION_MODES,
  VIDEO_TYPE_ALIASES,
  _reloadForTests,
  activeLintRules,
  canonicalizeVideoType,
  deriveVideoType,
  describeVideoTypes,
  getVideoTypePreset,
  resolveActiveVideoType,
  summarizeActiveVideoType,
};
