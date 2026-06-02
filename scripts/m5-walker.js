#!/usr/bin/env node
"use strict";

// End-to-end M5 walker. Acts as the orchestrator + storyboarder + composer to
// drive the FSM against a real source video without requiring the Claude Code
// adapter. Each phase prints progress and timing.

const fs = require("fs");
const path = require("path");

const { TOOL_HANDLERS } = require("../mcp/lib/tool-registry.js");

const PROJECT_ID = "dji-aerial";
// No bundled fixture (this is a template repo). Point the walker at any local
// video file or directory via VOB_WALKER_SOURCE:
//   VOB_WALKER_SOURCE=/path/to/clip.mp4 node scripts/m5-walker.js [phase]
const SOURCE = process.env.VOB_WALKER_SOURCE || "";
if (!SOURCE) {
  console.error(
    "m5-walker: set VOB_WALKER_SOURCE to a video file or directory, e.g.\n" +
    "  VOB_WALKER_SOURCE=/path/to/clip.mp4 node scripts/m5-walker.js [phase]",
  );
  process.exit(1);
}

async function step(label, fn) {
  const t = Date.now();
  process.stdout.write(`>> ${label} ... `);
  try {
    const r = await fn();
    console.log(`OK (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    return r;
  } catch (error) {
    console.log("FAIL");
    console.error("    " + (error && error.message ? error.message : String(error)));
    if (error && error.details) {
      console.error("    details: " + JSON.stringify(error.details).slice(0, 600));
    }
    throw error;
  }
}

function brief({ ingestSummary, intent }) {
  return [
    `# Brief: ${PROJECT_ID}`,
    "",
    "## Target",
    `- Platform: ${intent.target_platform}`,
    `- Duration: ${intent.target_duration}`,
    `- Source: 1 file, ${ingestSummary.duration_seconds.toFixed(1)}s, ${ingestSummary.primary_video.width}x${ingestSummary.primary_video.height} ${ingestSummary.primary_video.codec}`,
    "",
    "## Hook",
    "Open on the most kinetic aerial frame, hold the title for half a beat, snap to the next move.",
    "",
    "## Beats",
    "1. Aerial establishing pull (2s) with title overlay 'From above'",
    "2. Drone reframe / payoff hold (2s)",
    "",
    "## Tone",
    intent.tone,
    "",
    "## Constraints",
    `- Music/VO: ${intent.music_vo}`,
    `- Key moments to preserve: ${intent.key_moments}`,
    "- Technical: source is vertical 1512x2688 hevc → target 1080x1920 tiktok",
    "",
  ].join("\n");
}

function storyboard({ manifestPath, briefPath, source }) {
  return {
    schema_version: "1.0",
    project_id: PROJECT_ID,
    generated_at: new Date().toISOString(),
    source: { manifest_path: manifestPath, brief_path: briefPath },
    target: { platform: "tiktok", duration_seconds: 4, tone: "cinematic" },
    scenes: [
      {
        scene_id: "s001",
        sequence: 1,
        purpose: "hook",
        target_duration_seconds: 2,
        summary: "Aerial establishing pull at t=10s — the cleanest opening frame.",
        source_clips: [
          { manifest_file_index: 0, source_path: source, in_seconds: 10, out_seconds: 12 },
        ],
        overlays: ["text overlay: 'From above'"],
        captions: null,
        pacing: "medium",
      },
      {
        scene_id: "s002",
        sequence: 2,
        purpose: "payoff",
        target_duration_seconds: 2,
        summary: "Mid-flight reframe at t=80s — hold the moment.",
        source_clips: [
          { manifest_file_index: 0, source_path: source, in_seconds: 80, out_seconds: 82 },
        ],
        overlays: [],
        captions: null,
        pacing: "slow",
      },
    ],
    total_target_duration_seconds: 4,
    notes: "Short test cut — 4s, two beats, one hook overlay.",
  };
}

function composition(_source) {
  // Source media is symlinked into compose/source.mp4 after save_composition
  // runs (save-composition.js wipes the dir before writing). Referenced
  // relatively here so hyperframes' file server (rooted at the project dir)
  // can serve it; absolute paths outside the project root 404.
  const index = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1080px; height: 1920px; background: #000; font-family: sans-serif; }
#master-root { position: relative; width: 1080px; height: 1920px; overflow: hidden; }
video.full-bleed { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.clip { position: absolute; inset: 0; }
.overlay { display: flex; align-items: center; justify-content: center; pointer-events: none; }
.hook-title {
  color: #fff;
  font-size: 128px;
  font-weight: 900;
  letter-spacing: -0.02em;
  text-shadow: 0 6px 32px rgba(0,0,0,0.75);
  text-align: center;
  max-width: 920px;
  line-height: 1.0;
  padding: 0 32px;
}
</style>
</head>
<body>
<div id="master-root"
     data-composition-id="master"
     data-width="1080"
     data-height="1920"
     data-start="0"
     data-duration="4">
  <video id="scene-1-video" class="full-bleed" src="source.mp4" muted
         data-start="0" data-duration="2"
         data-media-start="10" data-playback-start="0"
         data-track-index="0"></video>
  <video id="scene-2-video" class="full-bleed" src="source.mp4" muted
         data-start="2" data-duration="2"
         data-media-start="80" data-playback-start="0"
         data-track-index="0"></video>
  <div id="hook-overlay" class="clip overlay" data-start="0.2" data-duration="1.5" data-track-index="1">
    <h1 class="hook-title">From above</h1>
  </div>
</div>
<script>
  // Hyperframes runtime expects every composition to register a timeline with
  // a GSAP-like API surface. For CSS-only compositions (no real animations to
  // sequence) we register a minimal stub that satisfies the methods
  // hyperframes calls during frame capture: .duration() returning total
  // seconds, .play()/.pause() as no-ops, and a few defensive others.
  (function () {
    var MASTER_DURATION = 4;
    function fluent() { return tl; }
    var tl = {
      duration: function () { return MASTER_DURATION; },
      totalDuration: function () { return MASTER_DURATION; },
      play: fluent,
      pause: fluent,
      seek: fluent,
      progress: function () { return 0; },
      time: function () { return 0; },
      paused: function () { return true; },
      isActive: function () { return false; },
      getChildren: function () { return []; },
      kill: fluent,
    };
    window.__timelines = window.__timelines || {};
    window.__timelines["master"] = tl;
  }());
</script>
</body>
</html>
`;
  return { "index.html": index };
}

async function main() {
  const phase = process.argv[2] || "all";
  console.log(`=== M5 walker — phase: ${phase} — project: ${PROJECT_ID}`);

  if (phase === "setup" || phase === "all") {
    // 1. init (idempotent: skip if already created)
    try {
      await step("init project", () =>
        TOOL_HANDLERS.vob_init_project({ project_id: PROJECT_ID, target: { format: "tiktok", duration: "4s" } }),
      );
    } catch (e) {
      if (/already exists/.test(e.message)) {
        console.log("   (already exists — continuing)");
      } else {
        throw e;
      }
    }

    // 2. ingest
    const ingest = await step("ingest (ffprobe)", () =>
      TOOL_HANDLERS.vob_ingest_file({ project_id: PROJECT_ID, source_path: SOURCE }),
    );
    console.log(
      `   src: ${ingest.files[0].duration_seconds.toFixed(1)}s ${ingest.files[0].primary_video.width}x${ingest.files[0].primary_video.height} ${ingest.files[0].primary_video.codec}`,
    );
    console.log(`   hyperframes: ${ingest.hyperframes.version || "?"}   ffmpeg: ${ingest.ffmpeg.version || "?"}`);

    await step("transition INGEST→INSPECT", () =>
      TOOL_HANDLERS.vob_transition_phase({ project_id: PROJECT_ID, to_phase: "INSPECT" }),
    );

    // 2b. inspect — extract thumbnails, audio, transcript
    const inspect = await step("inspect (ffmpeg + transcribe)", () =>
      TOOL_HANDLERS.vob_inspect_source({ project_id: PROJECT_ID }),
    );
    console.log(
      `   thumbs: ${inspect.thumb_count}   audio: ${inspect.audio_present ? "yes" : "no"}   speech: ${inspect.speech_detected ? `${inspect.word_count} words` : (inspect.skipped_reason || "none")}`,
    );
    await step("acknowledge inspect", () =>
      TOOL_HANDLERS.vob_acknowledge_inspect({ project_id: PROJECT_ID }),
    );

    await step("transition INSPECT→INTENT", () =>
      TOOL_HANDLERS.vob_transition_phase({ project_id: PROJECT_ID, to_phase: "INTENT" }),
    );

    // 3. intent answers (I pick reasonable values)
    const intent = {
      target_platform: "tiktok",
      target_duration: "4s",
      tone: "cinematic",
      key_moments: "aerial pull at ~10s, mid-flight reframe at ~80s",
      music_vo: "neither",
    };
    for (const [k, v] of Object.entries(intent)) {
      await step(`record intent ${k}`, () =>
        TOOL_HANDLERS.vob_record_intent_answer({ project_id: PROJECT_ID, key: k, value: v }),
      );
    }
    await step("transition INTENT→PLAN", () =>
      TOOL_HANDLERS.vob_transition_phase({ project_id: PROJECT_ID, to_phase: "PLAN" }),
    );

    // 4. PLAN: brief + storyboard, both authored and confirmed within one phase
    const state1 = TOOL_HANDLERS.vob_read_state({ project_id: PROJECT_ID });
    const briefText = brief({ ingestSummary: ingest.files[0], intent });
    await step("save brief", () =>
      TOOL_HANDLERS.vob_save_brief({ project_id: PROJECT_ID, content: briefText }),
    );
    await step("confirm brief", () =>
      TOOL_HANDLERS.vob_confirm_brief({ project_id: PROJECT_ID }),
    );

    // 5. storyboard (acting as storyboarder), still inside PLAN
    await step("log storyboarder invocation", () =>
      TOOL_HANDLERS.vob_log_storyboarder_invocation({ project_id: PROJECT_ID }),
    );
    const state2 = TOOL_HANDLERS.vob_read_state({ project_id: PROJECT_ID });
    const sb = storyboard({
      manifestPath: state2.manifest.path,
      briefPath: state2.brief.path,
      source: SOURCE,
    });
    await step("save storyboard", () =>
      TOOL_HANDLERS.vob_save_storyboard({ project_id: PROJECT_ID, content: JSON.stringify(sb) }),
    );
    await step("confirm storyboard", () =>
      TOOL_HANDLERS.vob_confirm_storyboard({ project_id: PROJECT_ID }),
    );
    await step("transition PLAN→COMPOSE", () =>
      TOOL_HANDLERS.vob_transition_phase({ project_id: PROJECT_ID, to_phase: "COMPOSE" }),
    );

    // 6. composition (acting as composer)
    await step("log composer invocation", () =>
      TOOL_HANDLERS.vob_log_composer_invocation({ project_id: PROJECT_ID }),
    );
    const comp = composition(SOURCE);
    await step("save composition", () =>
      TOOL_HANDLERS.vob_save_composition({ project_id: PROJECT_ID, files: comp }),
    );

    // Symlink the source video into compose/ AFTER save_composition (which
    // wipes the compose dir before writing). The composition references it as
    // a relative path because hyperframes' file server only serves files
    // under the project root.
    const composeRoot = path.join(require("os").homedir(), "video-vob-sessions", PROJECT_ID, "compose");
    const symlinkTarget = path.join(composeRoot, "source.mp4");
    try { fs.unlinkSync(symlinkTarget); } catch {}
    fs.symlinkSync(SOURCE, symlinkTarget);
    console.log(`>> symlink source into compose/ ... OK (${symlinkTarget})`);

    // 7. lint
    const lint = await step("lint composition", () =>
      TOOL_HANDLERS.vob_lint_composition({ project_id: PROJECT_ID }),
    );
    console.log(`   lint_status: ${lint.lint_status} (errors: ${lint.error_count}, warnings: ${lint.warning_count})`);
    if (lint.lint_status === "errors") {
      throw new Error("lint failed — see lint report");
    }
    await step("transition COMPOSE→PREVIEW", () =>
      TOOL_HANDLERS.vob_transition_phase({ project_id: PROJECT_ID, to_phase: "PREVIEW" }),
    );
  }

  if (phase === "preview" || phase === "all") {
    // 8. preview render (slow — minutes)
    const preview = await step("render preview", () =>
      TOOL_HANDLERS.vob_render_preview({ project_id: PROJECT_ID }),
    );
    console.log(`   preview at ${preview.render_path}`);
    console.log(`   wall-clock: ${preview.render_duration_seconds.toFixed(1)}s`);
    await step("confirm preview", () =>
      TOOL_HANDLERS.vob_confirm_preview({ project_id: PROJECT_ID }),
    );
    await step("transition PREVIEW→RENDER", () =>
      TOOL_HANDLERS.vob_transition_phase({ project_id: PROJECT_ID, to_phase: "RENDER" }),
    );
  }

  if (phase === "render" || phase === "all") {
    // 9. full render (slower)
    const render = await step("render full", () =>
      TOOL_HANDLERS.vob_render_full({ project_id: PROJECT_ID }),
    );
    console.log(`   final at ${render.mp4_path}`);
    console.log(`   wall-clock: ${render.render_duration_seconds.toFixed(1)}s, size: ${(render.file_size_bytes / 1e6).toFixed(2)} MB`);
    console.log(`   log: ${render.stderr_log_path}`);
    await step("confirm render", () =>
      TOOL_HANDLERS.vob_confirm_render({ project_id: PROJECT_ID }),
    );
    await step("transition RENDER→PACKAGE", () =>
      TOOL_HANDLERS.vob_transition_phase({ project_id: PROJECT_ID, to_phase: "PACKAGE" }),
    );
  }

  if (phase === "package" || phase === "all") {
    // 10. package
    const pkg = await step("package output", () =>
      TOOL_HANDLERS.vob_package_output({ project_id: PROJECT_ID }),
    );
    console.log(`   ${pkg.directory_path}`);
    console.log(`   final:     ${pkg.final_mp4_path}`);
    console.log(`   thumbnail: ${pkg.thumbnail_path}`);
    console.log(`   manifest:  ${pkg.manifest_path}`);
    console.log(`   readme:    ${pkg.readme_path}`);

    await step("transition PACKAGE→ITERATE", () =>
      TOOL_HANDLERS.vob_transition_phase({ project_id: PROJECT_ID, to_phase: "ITERATE" }),
    );
    await step("finalize iteration", () =>
      TOOL_HANDLERS.vob_finalize_iteration({ project_id: PROJECT_ID }),
    );
  }

  const final = TOOL_HANDLERS.vob_read_state_summary({ project_id: PROJECT_ID });
  console.log(`\n=== final phase: ${final.phase}   project: ${final.project_id}`);
}

main().catch((e) => {
  process.exitCode = 1;
  console.error("\nWALKER FAILED");
  console.error(e && e.stack ? e.stack : e);
});
