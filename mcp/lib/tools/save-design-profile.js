"use strict";

// vob_save_design_profile (v0.3.10) — author a named, reusable design profile into
// the install's `.vob-config/design-profiles/<name>.json` store. Used by the
// orchestrator's guided authoring flow (palette / font / vibe / tone / captions /
// music → a profile), and callable directly. Validation is LOOSE + FAIL-SAFE
// (mirrors target.design): bad tokens are dropped, never rejected; the ONLY hard
// error is an unusable name (a file can't be written without one). Returns the
// canonicalized profile + path + the intent pre-answers it carries.
//
// This is the durable successor to `--like`'s one genuinely useful capability
// ("make it look like that"): instead of a cross-project re-derivation, the look
// is captured once as a named token bundle. The tool writes to the INSTALL ROOT
// config dir (NOT a session dir), so it touches no FSM state and is unaffected by
// the session write-guards.

const path = require("path");
const fs = require("fs");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { writeFileAtomic } = require("../storage.js");
const {
  normalizeProfile,
  intentPrefill,
  invalidateCache,
  profilesDir,
} = require("../design-profiles.js");

function saveDesignProfile(args = {}) {
  // Normalize fail-safe (drops malformed tokens, strips the carve-out keys, maps
  // nothing it doesn't recognize). normalizeProfile returns null only when the
  // name yields no usable kebab slug — the one condition we cannot write a file for.
  const profile = normalizeProfile({
    name: args.name,
    description: args.description,
    version: args.version,
    look: args.look,
    editorial_defaults: args.editorial_defaults,
  });
  if (!profile) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      "design profile name must contain at least one alphanumeric character (it becomes a kebab-case file name)",
      { name: args.name == null ? null : String(args.name) },
    );
  }

  const filePath = path.join(profilesDir(), `${profile.name}.json`);
  const existed = fs.existsSync(filePath);
  const overwrite = args.overwrite !== false; // default: replace (idempotent re-authoring)
  if (existed && !overwrite) {
    throw new ToolError(
      ERROR_CODES.STATE_CONFLICT,
      `design profile "${profile.name}" already exists (pass overwrite:true to replace it)`,
      { name: profile.name, path: filePath },
    );
  }

  // Serialize the canonical profile, dropping empty blocks to keep the file lean.
  const doc = { name: profile.name };
  if (profile.description) doc.description = profile.description;
  doc.version = profile.version;
  if (Object.keys(profile.look).length) doc.look = profile.look;
  if (Object.keys(profile.editorial_defaults).length) doc.editorial_defaults = profile.editorial_defaults;

  writeFileAtomic(filePath, `${JSON.stringify(doc, null, 2)}\n`);
  invalidateCache(); // so the new/updated profile resolves immediately in this long-lived process

  return {
    saved: true,
    name: profile.name,
    path: filePath,
    existed,
    profile: doc,
    // The stylistic INTENT pre-answers this profile carries (never key_moments /
    // target_duration) — surfaced so the caller can preview what will be pre-filled.
    intent_prefill: intentPrefill(profile),
  };
}

module.exports = Object.freeze({
  name: "vob_save_design_profile",
  description:
    "Author a named, reusable design profile into .vob-config/design-profiles/<name>.json. Bundles a visual `look` (palette/typography/caption_style/motion/grade/slots) + stylistic `editorial_defaults` (video_type/target_platform/tone/music_vo/caption_animation/pacing/transition_lean/speed/layout — NEVER key_moments or target_duration). Validation is fail-safe (bad tokens dropped, never rejected); only an unusable name errors INVALID_ARGUMENTS. Replaces --like. Returns {saved, name, path, existed, profile, intent_prefill}.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Profile name (kebab-case; becomes the file name)." },
      description: { type: "string" },
      version: { type: "integer", minimum: 1 },
      look: {
        type: "object",
        additionalProperties: true,
        description: "Visual look: { palette{bg,surface,text,text_muted,accent,accent_2}, typography{headline,caption,body}, caption_style, motion, grade, slots? } — resolves into target.design + --vob-* tokens.",
      },
      editorial_defaults: {
        type: "object",
        additionalProperties: true,
        description: "Stylistic INTENT pre-answers: { video_type, target_platform, tone, music_vo, caption_animation, pacing, transition_lean, speed, layout }. key_moments / target_duration are stripped (carve-out).",
      },
      overwrite: { type: "boolean", description: "Replace an existing profile of the same name (default true)." },
    },
    required: ["name"],
  },
  handler: saveDesignProfile,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: [],
  hook_required: false,
});
