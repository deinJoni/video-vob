"use strict";

const { ERROR_CODES, ToolError } = require("../envelope.js");
const {
  assertSafeProjectId,
  statePath,
  storyboardMarkdownPath,
  storyboardPath,
} = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const {
  allStoryboardScenes,
  storyboardHasShorts,
  storyboardTimelines,
  validateStoryboard,
  validateStoryboardContent,
} = require("../storyboard-schema.js");
const { renderStoryboardMarkdown } = require("../storyboard-markdown.js");

const MAX_STORYBOARD_LENGTH = 256 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function parseContent(rawContent) {
  let parsed;
  if (typeof rawContent === "string") {
    if (rawContent.trim() === "") {
      throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "content must be a non-empty JSON string");
    }
    if (rawContent.length > MAX_STORYBOARD_LENGTH) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `content exceeds ${MAX_STORYBOARD_LENGTH} character limit`,
      );
    }
    try {
      parsed = JSON.parse(rawContent);
    } catch (error) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `content is not valid JSON: ${error.message || String(error)}`,
      );
    }
  } else if (rawContent !== null && typeof rawContent === "object" && !Array.isArray(rawContent)) {
    if (JSON.stringify(rawContent).length > MAX_STORYBOARD_LENGTH) {
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `content exceeds ${MAX_STORYBOARD_LENGTH} character limit`,
      );
    }
    parsed = rawContent;
  } else {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENTS, "content must be a JSON object or a string of JSON");
  }
  const verdict = validateStoryboard(parsed);
  if (!verdict.ok) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `storyboard schema validation failed: ${verdict.errors.join("; ")}`,
      { schema_errors: verdict.errors },
    );
  }
  return parsed;
}

function saveStoryboard(args) {
  const id = assertSafeProjectId(args && args.project_id);
  const storyboard = parseContent(args && args.content);

  return withSessionLock(id, () => {
    const state = readSessionStateStrict(id);

    const contentCheck = validateStoryboardContent(storyboard, state);
    if (!contentCheck.ok) {
      const shown = contentCheck.errors.slice(0, 10);
      const extra = contentCheck.errors.length - shown.length;
      throw new ToolError(
        ERROR_CODES.INVALID_ARGUMENTS,
        `storyboard plan lint failed: ${shown.map((e) => (typeof e === "string" ? e : `${e.code}: ${e.message}`)).join("; ")}${extra > 0 ? ` (+${extra} more)` : ""}`,
        {
          plan_errors: shown,
          // warnings ride on rejection too — the storyboarder fixes both in
          // one revision pass
          plan_warnings: contentCheck.warnings.slice(0, 10),
          error_count: contentCheck.errors.length,
          warning_count: contentCheck.warnings.length,
        },
      );
    }
    const planWarnings = contentCheck.warnings;

    const jsonFile = storyboardPath(id);
    const mdFile = storyboardMarkdownPath(id);
    const jsonText = `${JSON.stringify(storyboard, null, 2)}\n`;
    const mdText = renderStoryboardMarkdown(storyboard, { planWarnings });

    writeFileAtomic(jsonFile, jsonText);
    writeFileAtomic(mdFile, mdText);

    const ts = nowIso();
    const prevStoryboard = state.storyboard && typeof state.storyboard === "object" && !Array.isArray(state.storyboard)
      ? state.storyboard
      : null;
    const prevRevisionCount = prevStoryboard && Number.isInteger(prevStoryboard.revision_count)
      ? prevStoryboard.revision_count
      : 0;
    const revisionCount = prevRevisionCount + 1;

    // Mode-agnostic stamps: scenes-form documents keep their exact prior
    // values; fan-out documents count ALL shorts' scenes and sum their totals.
    const fanOut = storyboardHasShorts(storyboard);
    const timelines = storyboardTimelines(storyboard);
    const sceneCount = allStoryboardScenes(storyboard).length;
    const totalDurationSeconds = fanOut
      ? timelines.reduce((acc, t) => acc + (Number.isFinite(t.total_target_duration_seconds) ? t.total_target_duration_seconds : 0), 0)
      : storyboard.total_target_duration_seconds;
    const shortsDigest = fanOut
      ? timelines.map((t) => ({
        short_id: t.short_id,
        title: t.title,
        total_target_duration_seconds: t.total_target_duration_seconds,
        scene_count: t.scenes.length,
      }))
      : null;

    const next = {
      ...state,
      storyboard: {
        artifact_path: jsonFile,
        markdown_path: mdFile,
        saved_at: ts,
        confirmed: false,
        confirmed_at: null,
        revision_count: revisionCount,
        scene_count: sceneCount,
        total_duration_seconds: totalDurationSeconds,
        ...(fanOut ? { short_count: timelines.length, shorts: shortsDigest } : {}),
        plan_lint: {
          error_count: 0,
          warning_count: planWarnings.length,
          warnings: planWarnings.slice(0, 25), // bounded in state
          linted_at: ts,
        },
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(state.history) ? state.history : []),
        { kind: "storyboard_saved", at: ts, revision_count: revisionCount, warning_count: planWarnings.length },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      artifact_path: jsonFile,
      markdown_path: mdFile,
      saved_at: ts,
      confirmed: false,
      revision_count: revisionCount,
      scene_count: sceneCount,
      total_duration_seconds: totalDurationSeconds,
      ...(fanOut ? { short_count: timelines.length, shorts: shortsDigest } : {}),
      plan_lint: {
        error_count: 0,
        warning_count: planWarnings.length,
        warnings: planWarnings.slice(0, 10), // ≤10 inline per D1
      },
    };
  });
}

module.exports = Object.freeze({
  name: "vob_save_storyboard",
  description: "Save the storyboard (content may be a JSON object or string). Schema 1.0 = one timeline (scenes[] + total_target_duration_seconds); schema 1.1 additionally allows the multi-short fan-out form: top-level shorts[] of {short_id, title, sequence, total_target_duration_seconds, scenes[], broll_placements?, notes?} with the top-level timeline fields omitted and scene_ids globally unique. Validates shape, then runs plan lint (per short in fan-out; findings carry short_id): errors (out-of-range clips, captions-on-silent, narration-span violations, duplicate scene_ids) reject the save; warnings (hook placement/length, duration drift or per-short range, b_roll holds, key-moment coverage, clean-speech straddles) return in plan_lint, persist to state, and render into storyboard.md for the plan gate. Any save resets confirmed:false and bumps revision_count.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      content: {
        // NB: the object branch MUST keep additionalProperties:true — the
        // mini-validator defaults objects to additionalProperties:false (the
        // bug class that broke save_classification).
        oneOf: [
          { type: "string", minLength: 1, maxLength: MAX_STORYBOARD_LENGTH },
          { type: "object", additionalProperties: true },
        ],
        description: "Storyboard document (schema 1.0, or 1.1 for the shorts[] fan-out form) as a JSON object or a JSON string.",
      },
    },
    required: ["project_id", "content"],
  },
  handler: saveStoryboard,
  role_bundles: ["orchestrator", "storyboarder"],
  mutating: true,
  global_preapproval: false,
  network_access: false,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["storyboard.json", "storyboard.md", "state.json"],
  hook_required: false,
});
