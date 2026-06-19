"use strict";

// Design profiles (v0.3.10) — named, reusable, self-contained style bundles that
// capture how a project's OUTPUT should look and feel: a visual `look` (palette /
// typography / caption_style / motion / grade / optional component slots) plus a
// set of `editorial_defaults` (the stylistic INTENT answers a brand reuses).
// Authored once, applied to any future project BY NAME — so every output shares
// the same identity without re-deriving it.
//
// This REPLACES the v1 `--like` lineage mechanism (`state.style.derived_from`),
// which pointed a new project at a prior project_id and re-derived its look every
// time via a cross-project read. A design profile is a first-class NAMED store
// with no cross-project read.
//
// Orthogonal to the video-type preset (video-types.js): a preset says WHAT KIND
// of video this is (editorial rules, lint ruleset, render segmentation); a profile
// says WHAT MY BRAND LOOKS LIKE + my house editorial defaults. The same profile
// renders as a social-short OR a cinematic long-form because the look is expressed
// as portable `--vob-*` tokens (every design-system component reads them), and a
// profile may *select* a `video_type` as one of its editorial defaults. Keep the
// two axes orthogonal.
//
// Resolution of the ACTIVE profile is late-bound through ONE function,
// resolveActiveDesignProfile(state) — mirroring resolveActiveVideoType:
//   1. VOB_DESIGN_PROFILE env var               (per-process override)
//   2. recorded `design_profile` intent answer  (the human's explicit INTENT choice)
//   3. state.design_profile.name                (the init-time `{design_profile}` stamp — the --like successor)
//   4. none                                      (fall through to the video-type design_default, unchanged)
// (The BUILD spec lists env > recorded-answer > none; tier 3 is the faithful
// generalization — a profile NAMED at vob_init_project must resolve before INTENT
// records anything. An explicit INTENT answer still wins over the init stamp,
// matching "explicit human answer > profile default".)
//
// User profiles: each `.vob-config/design-profiles/*.json` file is ONE profile;
// read-once-per-process; absent/malformed/unnamed files are skipped SILENTLY
// (never throw). A user profile whose `name` matches a built-in MERGES over it
// (palette/typography one level deep, scalars replace) — same forgiveness as
// video-types.js mergePreset. An unknown profile NAME always falls through to
// "none" — never an error (identical to an unrecognized video_type).
// VOB_DESIGN_PROFILES_DIR overrides the directory (tests/installs).
//
// Everything here is LOOSE + FAIL-SAFE (like target.design): a bad token is
// dropped/ignored, never rejects. Nothing here lints or gates.

const fs = require("fs");
const path = require("path");

const { canonicalizeVideoType, getVideoTypePreset, resolveActiveVideoType } = require("./video-types.js");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// --- editorial_defaults → intent-answer key mapping ---------------------------
// A profile's editorial_defaults use friendly names; the INTENT layer records
// against the canonical intent keys. This map is the SINGLE bridge between the two
// vocabularies. The carve-out keys (key_moments, target_duration) are DELIBERATELY
// ABSENT — a profile may NEVER default content-specific (`key_moments`) or
// content/campaign-specific (`target_duration`) keys. This inherits the exact rule
// `--like` already enforced (the five required-intent-key contract is untouched).
const EDITORIAL_DEFAULT_KEYS = Object.freeze({
  video_type: "video_type",
  target_platform: "target_platform",
  tone: "tone",
  music_vo: "music_vo",
  caption_animation: "caption_animation_intent",
  pacing: "pacing_intent",
  transition_lean: "transition_intent",
  speed: "speed_intent",
  layout: "layout_intent",
});

// --- built-in starter profiles ------------------------------------------------
// Seeded from the per-video-type design_default blocks already in video-types.js
// (the "we already have some" starter material), spanning distinct aesthetics:
// punchy vertical social, clean corporate explainer, warm cinematic, warm podcast,
// stark mono editorial. Each carries a fairly complete `look` (so it stands alone)
// plus stylistic `editorial_defaults` (NEVER key_moments / target_duration). The
// effective look still gap-fills any omitted token from the active video-type's
// design_default at resolve time (see effectiveLook), so a partial user profile is
// also fine. Palette keys map to --vob-* tokens: bg→--vob-bg, surface→--vob-surface,
// text→--vob-text, text_muted→--vob-text-muted, accent→--vob-accent, accent_2→--vob-accent-2.
const BUILT_IN_DESIGN_PROFILES = Object.freeze({
  "bold-social": {
    name: "bold-social",
    description: "Punchy vertical social — black canvas, Anton headlines, red/yellow accents, fast snap motion, bold kinetic captions.",
    version: 1,
    look: {
      palette: { bg: "#0A0A0A", surface: "#14141A", text: "#FFFFFF", text_muted: "#B8B8C0", accent: "#FF3B30", accent_2: "#FFD60A" },
      typography: { headline: "Anton", caption: "Hanken Grotesk", body: "Inter" },
      caption_style: "bold-pop",
      motion: "fast-snap",
      grade: "high-contrast",
    },
    editorial_defaults: {
      video_type: "social-short",
      target_platform: "tiktok",
      tone: "energetic, punchy, direct",
      music_vo: "music bed under voiceover, burned captions",
      caption_animation: "pop",
      pacing: "fast",
      speed: "light",
      transition_lean: "punchy cuts, occasional whip/zoom",
    },
  },
  "clean-corporate": {
    name: "clean-corporate",
    description: "Clean corporate explainer — near-black ground, Hanken Grotesk headlines, calm blue accent, soft medium motion, clean-pill captions.",
    version: 1,
    look: {
      palette: { bg: "#0B0B0C", surface: "#15161A", text: "#F5F5F0", text_muted: "#A8A8AE", accent: "#3B82F6" },
      typography: { headline: "Hanken Grotesk", caption: "Inter", body: "Inter" },
      caption_style: "clean-pill",
      motion: "medium-soft",
      grade: "none",
    },
    editorial_defaults: {
      video_type: "long-form",
      target_platform: "youtube_long",
      tone: "clear, professional, approachable",
      music_vo: "voiceover led, subtle music bed",
      caption_animation: "pop",
      pacing: "medium",
      transition_lean: "restrained — cut + occasional dip",
    },
  },
  "cinematic-gold": {
    name: "cinematic-gold",
    description: "Warm cinematic film — true black, Playfair Display titles, EB Garamond body, antique-gold accent, slow motion, desaturated grade.",
    version: 1,
    look: {
      palette: { bg: "#000000", surface: "#0E0D0B", text: "#F2EFE8", text_muted: "#B9B3A4", accent: "#C9A227" },
      typography: { headline: "Playfair Display", caption: "Inter", body: "EB Garamond" },
      caption_style: "minimal-lower-third",
      motion: "slow-cinematic",
      grade: "desaturated",
      slots: { grade: "grade-film-desat" },
    },
    editorial_defaults: {
      video_type: "cinematic",
      target_platform: "cinematic",
      tone: "evocative, restrained, filmic",
      music_vo: "music-led, sparse voiceover",
      pacing: "slow",
      transition_lean: "gentle dissolves and dips",
    },
  },
  "warm-podcast": {
    name: "warm-podcast",
    description: "Warm conversational podcast/talk — soft dark ground, violet accent, Hanken Grotesk headlines, medium motion, warm grade, split-friendly.",
    version: 1,
    look: {
      palette: { bg: "#111111", surface: "#1A1820", text: "#F5F5F0", text_muted: "#ACA6A0", accent: "#8B5CF6" },
      typography: { headline: "Hanken Grotesk", caption: "Inter", body: "Inter" },
      caption_style: "minimal-lower-third",
      motion: "medium-soft",
      grade: "warm",
    },
    editorial_defaults: {
      video_type: "podcast",
      target_platform: "youtube_long",
      tone: "conversational, warm, candid",
      music_vo: "voices with a light music bed",
      pacing: "medium",
      layout: "split",
    },
  },
  "mono-editorial": {
    name: "mono-editorial",
    description: "Stark monochrome editorial — near-black ground, Archivo Black headlines, near-white accent with a red highlight, dramatic mono grade.",
    version: 1,
    look: {
      palette: { bg: "#050505", surface: "#121212", text: "#FAFAFA", text_muted: "#9A9A9A", accent: "#E5E5E5", accent_2: "#FF4D4D" },
      typography: { headline: "Archivo Black", caption: "Hanken Grotesk", body: "Inter" },
      caption_style: "bold-pop",
      motion: "medium-soft",
      grade: "monochrome",
      slots: { grade: "grade-bw" },
    },
    editorial_defaults: {
      video_type: "general",
      target_platform: "landscape",
      tone: "stark, editorial, confident",
      music_vo: "music-led",
      caption_animation: "pop",
      pacing: "medium",
    },
  },
});

// --- normalization (loose, fail-safe) -----------------------------------------

// kebab-case lower; strips anything that isn't [a-z0-9]; "" when nothing usable.
function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Keep only non-empty string values (a malformed entry is dropped, never throws).
function normalizeStringMap(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

// slots: each value is either a component-name string or a { default, alternates[] }
// object — kept loose (the composer falls back when a slot names an unknown
// component, exactly like the design-system kit already does). Strings + plain
// objects pass through; anything else is dropped.
function normalizeSlots(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {};
  for (const [slot, v] of Object.entries(value)) {
    if (typeof v === "string" && v.trim()) out[slot] = v.trim();
    else if (isPlainObject(v)) out[slot] = { ...v };
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeLook(look) {
  if (!isPlainObject(look)) return {};
  const out = {};
  const pal = normalizeStringMap(look.palette);
  if (pal) out.palette = pal;
  const typ = normalizeStringMap(look.typography);
  if (typ) out.typography = typ;
  for (const k of ["caption_style", "motion", "grade"]) {
    if (typeof look[k] === "string" && look[k].trim()) out[k] = look[k].trim();
  }
  const slots = normalizeSlots(look.slots);
  if (slots) out.slots = slots;
  return out;
}

// Only the known stylistic editorial-default keys survive; carve-out keys
// (key_moments, target_duration) are not in EDITORIAL_DEFAULT_KEYS so they are
// stripped automatically even if a hand-authored profile tried to set them.
function normalizeEditorialDefaults(ed) {
  if (!isPlainObject(ed)) return {};
  const out = {};
  for (const friendly of Object.keys(EDITORIAL_DEFAULT_KEYS)) {
    const v = ed[friendly];
    if (typeof v === "string" && v.trim()) out[friendly] = v.trim();
  }
  return out;
}

// Raw profile object -> normalized profile, or null when it has no usable name
// (an unnamed file is skipped silently by the loader).
function normalizeProfile(raw) {
  if (!isPlainObject(raw)) return null;
  const name = normalizeName(raw.name);
  if (!name) return null;
  return Object.freeze({
    name,
    description: typeof raw.description === "string" ? raw.description.trim() : "",
    version: Number.isInteger(raw.version) && raw.version > 0 ? raw.version : 1,
    look: Object.freeze(normalizeLook(raw.look)),
    editorial_defaults: Object.freeze(normalizeEditorialDefaults(raw.editorial_defaults)),
  });
}

// Merge a user profile over a same-named base: look palette/typography deep-merge
// one level, look scalars + slots replace, editorial_defaults shallow-merge,
// description/version replace when present. Mirrors video-types.js mergePreset.
function mergeProfile(base, override) {
  const bl = base.look || {};
  const ol = override.look || {};
  const mergedLook = {
    ...bl,
    ...ol,
    palette: { ...(isPlainObject(bl.palette) ? bl.palette : {}), ...(isPlainObject(ol.palette) ? ol.palette : {}) },
    typography: { ...(isPlainObject(bl.typography) ? bl.typography : {}), ...(isPlainObject(ol.typography) ? ol.typography : {}) },
  };
  if (!Object.keys(mergedLook.palette).length) delete mergedLook.palette;
  if (!Object.keys(mergedLook.typography).length) delete mergedLook.typography;
  return Object.freeze({
    name: base.name,
    description: override.description || base.description || "",
    version: override.version || base.version || 1,
    look: Object.freeze(mergedLook),
    editorial_defaults: Object.freeze({ ...base.editorial_defaults, ...override.editorial_defaults }),
  });
}

// --- the .vob-config/design-profiles/ directory loader (read-once) ------------

const DEFAULT_PROFILES_DIR = path.join(path.resolve(__dirname, "..", ".."), ".vob-config", "design-profiles");

function profilesDir() {
  const env = (process.env.VOB_DESIGN_PROFILES_DIR || "").trim();
  return env || DEFAULT_PROFILES_DIR;
}

function readUserProfiles() {
  let files;
  try {
    files = fs.readdirSync(profilesDir());
  } catch {
    return []; // absent dir -> built-ins only, silently
  }
  const out = [];
  for (const f of files.slice().sort()) {
    if (!f.toLowerCase().endsWith(".json")) continue;
    if (f.startsWith(".") || f.startsWith("_")) continue; // dot/underscore files skipped
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(profilesDir(), f), "utf8"));
      const norm = normalizeProfile(parsed);
      if (norm) out.push(norm);
    } catch {
      /* malformed JSON / unreadable -> skip silently (mirrors siblings) */
    }
  }
  return out;
}

function buildEffectiveTable() {
  const profiles = {};
  for (const [name, raw] of Object.entries(BUILT_IN_DESIGN_PROFILES)) {
    profiles[name] = normalizeProfile(raw);
  }
  const userNames = [];
  for (const up of readUserProfiles()) {
    profiles[up.name] = Object.prototype.hasOwnProperty.call(profiles, up.name)
      ? mergeProfile(profiles[up.name], up) // user file tweaks a built-in
      : up;                                  // brand-new profile
    if (!userNames.includes(up.name)) userNames.push(up.name);
  }
  return { profiles, userNames };
}

let cachedTable = null;

function effectiveTable() {
  if (!cachedTable) cachedTable = buildEffectiveTable();
  return cachedTable;
}

function _reloadForTests() {
  cachedTable = null;
}

// Production cache invalidation — vob_save_design_profile calls this after writing
// a new profile so it resolves immediately in the long-lived MCP server (the table
// is otherwise read-once-per-process). Same effect as the test seam, clearer name.
function invalidateCache() {
  cachedTable = null;
}

// Unknown/empty name -> null (never an error). The resolver then falls through.
function getDesignProfile(name) {
  const norm = normalizeName(name);
  if (!norm) return null;
  const t = effectiveTable();
  return Object.prototype.hasOwnProperty.call(t.profiles, norm) ? t.profiles[norm] : null;
}

// --- resolution ----------------------------------------------------------------

function intentAnswers(state) {
  const intent = state && isPlainObject(state.intent) ? state.intent : null;
  return intent && isPlainObject(intent.answers) ? intent.answers : {};
}

// The recorded design_profile answer may be a bare string or the canonicalized
// { raw, name } snapshot — return whichever names a profile.
function recordedProfileName(answers) {
  const v = answers.design_profile;
  if (typeof v === "string" && v.trim()) return v.trim();
  if (isPlainObject(v)) {
    if (typeof v.name === "string" && v.name.trim()) return v.name.trim();
    if (typeof v.raw === "string" && v.raw.trim()) return v.raw.trim();
  }
  return "";
}

// resolveActiveDesignProfile(state) -> { name, source, profile }
//   source: "env" | "intent" | "init" | "none"
// Never throws; an unknown name at any tier falls through to the next.
function resolveActiveDesignProfile(state) {
  const env = (process.env.VOB_DESIGN_PROFILE || "").trim();
  if (env) {
    const p = getDesignProfile(env);
    if (p) return { name: p.name, source: "env", profile: p };
    // unrecognized env value: ignored (falls through) — same forgiveness as video_type
  }
  const answers = intentAnswers(state);
  const recorded = recordedProfileName(answers);
  if (recorded) {
    const p = getDesignProfile(recorded);
    if (p) return { name: p.name, source: "intent", profile: p };
  }
  const stamped = state && isPlainObject(state.design_profile) && typeof state.design_profile.name === "string"
    ? state.design_profile.name.trim()
    : "";
  if (stamped) {
    const p = getDesignProfile(stamped);
    if (p) return { name: p.name, source: "init", profile: p };
  }
  return { name: null, source: "none", profile: null };
}

// The effective look = the active video-type design_default with the profile's
// look merged over it (so a partial profile still produces a complete token set,
// and the precedence "active design profile > video-type preset design_default"
// is realized). The per-project target.design override sits ABOVE this and is
// applied downstream by whoever writes the storyboard. baseType prefers the
// profile's own declared video_type (its intended format), else the active
// resolved type, else general.
function effectiveLook(profile, state) {
  if (!profile) return null;
  const declared = profile.editorial_defaults && profile.editorial_defaults.video_type;
  let baseType;
  if (typeof declared === "string" && declared.trim()) {
    const { canonical } = canonicalizeVideoType(declared);
    baseType = canonical || declared;
  } else {
    baseType = resolveActiveVideoType(state).canonical || "general";
  }
  const baseDesign = getVideoTypePreset(baseType).design_default || {};
  const look = profile.look || {};
  const out = {
    palette: { ...(isPlainObject(baseDesign.palette) ? baseDesign.palette : {}), ...(isPlainObject(look.palette) ? look.palette : {}) },
    typography: { ...(isPlainObject(baseDesign.typography) ? baseDesign.typography : {}), ...(isPlainObject(look.typography) ? look.typography : {}) },
    caption_style: look.caption_style || baseDesign.caption_style || null,
    motion: look.motion || baseDesign.motion || null,
    grade: look.grade || baseDesign.grade || null,
  };
  if (isPlainObject(look.slots)) out.slots = { ...look.slots };
  return out;
}

// editorial_defaults remapped onto the canonical intent keys, ready for the
// orchestrator to record as pre-answers (precedence: explicit human answer >
// this profile default > derivation/ask). NEVER carries key_moments / target_duration.
function intentPrefill(profile) {
  const out = {};
  if (!profile || !isPlainObject(profile.editorial_defaults)) return out;
  for (const [friendly, intentKey] of Object.entries(EDITORIAL_DEFAULT_KEYS)) {
    const v = profile.editorial_defaults[friendly];
    if (typeof v === "string" && v.trim()) out[intentKey] = v.trim();
  }
  return out;
}

// --- canonicalization for record_intent_answer --------------------------------
// Mirrors canonicalizeVideoType: an unrecognized name stores name:null so the
// resolver falls through (to the init stamp / none) instead of pinning a wrong
// profile. Recognized input snapshots the canonical name. Lean by design — the
// look is re-resolved from the name on demand (cheap, cached), not stored.
function canonicalizeDesignProfile(raw) {
  const rawStr = typeof raw === "string" ? raw.trim() : (raw == null ? "" : String(raw).trim());
  const p = getDesignProfile(rawStr);
  return { raw: rawStr, name: p ? p.name : null };
}

// --- introspection (vob_doctor / read_state_summary) --------------------------

function lookDigest(look) {
  const l = isPlainObject(look) ? look : {};
  return {
    palette: isPlainObject(l.palette) ? { ...l.palette } : null,
    typography: isPlainObject(l.typography) ? { ...l.typography } : null,
    caption_style: typeof l.caption_style === "string" ? l.caption_style : null,
    motion: typeof l.motion === "string" ? l.motion : null,
    grade: typeof l.grade === "string" ? l.grade : null,
    slots: isPlainObject(l.slots) ? { ...l.slots } : null,
  };
}

function profileDigest(p) {
  return {
    name: p.name,
    description: p.description || null,
    look: lookDigest(p.look),
    editorial_defaults: { ...p.editorial_defaults },
  };
}

function describeDesignProfiles() {
  const table = effectiveTable();
  const env = (process.env.VOB_DESIGN_PROFILE || "").trim();
  return {
    config_dir: profilesDir(),
    config_present: table.userNames.length > 0,
    env_override: env || null,
    built_in: Object.keys(BUILT_IN_DESIGN_PROFILES),
    user_defined: table.userNames,
    profiles: Object.values(table.profiles).map(profileDigest),
  };
}

// Lean per-project digest for read_state_summary + the storyboarder/composer
// spawns. When no profile is active, returns { name: null, source } and the
// orchestrator falls back to the video-type design_default (existing behavior).
function summarizeActiveDesignProfile(state) {
  const active = resolveActiveDesignProfile(state);
  if (!active.profile) {
    return { name: null, source: active.source };
  }
  const p = active.profile;
  return {
    name: p.name,
    source: active.source,
    description: p.description || null,
    look: effectiveLook(p, state),
    editorial_defaults: { ...p.editorial_defaults },
    intent_prefill: intentPrefill(p),
    editorial_default_keys: Object.keys(p.editorial_defaults),
  };
}

module.exports = {
  BUILT_IN_DESIGN_PROFILES,
  EDITORIAL_DEFAULT_KEYS,
  _reloadForTests,
  canonicalizeDesignProfile,
  describeDesignProfiles,
  effectiveLook,
  getDesignProfile,
  intentPrefill,
  invalidateCache,
  normalizeProfile,
  profilesDir,
  resolveActiveDesignProfile,
  summarizeActiveDesignProfile,
};
