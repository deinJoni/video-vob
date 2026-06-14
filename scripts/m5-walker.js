#!/usr/bin/env node
"use strict";

// v2 walker — drives the FSM through executeTool (schema validation + the
// envelope, not bare handlers), modeling CURRENT conventions: scene clips
// ./source/sNNN-K.mp4 with data-media-start="0", timing attrs directly ON the
// media elements (hyperframes media_missing_data_start), class="clip" on timed
// non-media elements, a plan-lint-clean storyboard, a QC-clean composition, and
// the font kit. Negative fixtures exercise the plan-lint and composition-QC
// rejection paths (errors AND warnings asserted), so this stays the executable
// spec.
//
// Phases: setup | preview | render | package | all | fanout | general |
// longform | overlays | gaps | stillsqc | captions | subject | transitions. Heavy steps beyond setup are env-gated
// by invocation; the in-COMPOSE snapshot QC step is gated by VOB_WALKER_SNAPSHOT=1.
// `stillsqc` is fully synthetic (ffmpeg-generated stills, no source/render): it
// covers the auto-QC-of-stills pass — the pure luma classifier (still-qc.js), the
// ffprobe signalstats path (ffprobe.js::signalstatsLuma), and vob_qc_stills.
// `fanout` is standalone (own project <id>-fanout): the multi-short storyboard
// (schema 1.1 shorts[]), per-short plan lint, union clip materialization,
// short_id-scoped composition QC, the import-with-normalize deliverable loop,
// the package_output fan-out guard, and the shorts_missing_deliverables gate —
// no real renders. The v3 phases are likewise standalone (own projects):
// `general` = P1 presets/format (video_type resolution, lint rulesets, fps QC);
// `longform` = P2 segmented render + vob_assemble_video (REAL renders);
// `overlays` = P3 typed overlay layer; `gaps` = P4 b-roll gap shopping list.

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const { executeTool } = require("../mcp/lib/dispatch.js");
const { snapshotsDir } = require("../mcp/lib/paths.js");
const { classifyStillLuma } = require("../mcp/lib/still-qc.js");
const { signalstatsLuma } = require("../mcp/lib/ffprobe.js");

const PROJECT_ID = process.env.VOB_WALKER_PROJECT || "dji-aerial";
// No bundled fixture (this is a template repo). Point the walker at any local
// video file ≥15s via VOB_WALKER_SOURCE:
//   VOB_WALKER_SOURCE=/path/to/clip.mp4 node scripts/m5-walker.js [phase]
const SOURCE = process.env.VOB_WALKER_SOURCE || "";
// `stillsqc` is fully synthetic (ffmpeg-generated test stills) and needs no
// source video — every other phase lays out a fixture against a real clip.
if (!SOURCE && process.argv[2] !== "stillsqc") {
  console.error(
    "m5-walker: set VOB_WALKER_SOURCE to a video file or directory, e.g.\n" +
    "  VOB_WALKER_SOURCE=/path/to/clip.mp4 node scripts/m5-walker.js [phase]",
  );
  process.exit(1);
}

// Every call goes through schema validation + the envelope (the
// save_classification lesson: a handler-only test can pass a payload the
// validator rejects).
async function call(name, args) {
  const env = await executeTool(name, args);
  if (!env.ok) {
    const err = new Error(`${name}: [${env.error.code}] ${env.error.message}`);
    err.code = env.error.code;
    err.details = env.error.details;
    throw err;
  }
  return env.data;
}

// Negative-fixture helper: assert a call FAILS with a matching error code.
// Returns the error object (code/message/details); throws on unexpected success.
async function expectError(name, args, codeRe) {
  const env = await executeTool(name, args);
  if (env.ok) {
    throw new Error(`${name}: expected an error matching ${codeRe} but the call succeeded`);
  }
  if (!codeRe.test(env.error.code)) {
    throw new Error(`${name}: expected error code matching ${codeRe}, got [${env.error.code}] ${env.error.message}`);
  }
  return env.error;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`walker assertion failed: ${msg}`);
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

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Fixture planning — every in/out derives from the ACTUAL source duration (and
// the transcript + clean-speech keep-spans, when present), never hardcoded
// offsets. Windows snap INSIDE a keep-span when one fits, mirroring the
// storyboarder craft rule, so the good fixture is straddle-warning-silent.

function placeWindow({ keepSpans, len, preferStart, durationSeconds }) {
  const spans = (Array.isArray(keepSpans) ? keepSpans : []).filter(
    (s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && (s.end - s.start) >= len + 0.1,
  );
  if (spans.length > 0) {
    const span = spans.find((s) => preferStart >= s.start && preferStart + len <= s.end)
      || spans.find((s) => s.start >= preferStart)
      || spans[spans.length - 1];
    const start = Math.min(Math.max(preferStart, span.start + 0.05), span.end - len - 0.05);
    return { in: round3(start), out: round3(start + len) };
  }
  // No span fits (or no clean_speech) — duration-proportional fallback; a
  // straddle WARNING may ride along, which is fine (warnings never reject).
  const start = Math.min(Math.max(preferStart, 0), durationSeconds - len - 0.1);
  return { in: round3(start), out: round3(start + len) };
}

function planWindows({ durationSeconds, transcript, keepSpans }) {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 15) {
    throw new Error(
      `walker needs a source ≥15s to lay out its 3-scene fixture (got ${durationSeconds}s) — point VOB_WALKER_SOURCE at a longer clip`,
    );
  }
  const D = durationSeconds;
  // Beat window anchors on the first transcribed word so the captioned scene
  // provably overlaps speech (the captions-on-silent plan-lint error).
  const firstWordStart = Array.isArray(transcript) && transcript.length > 0
    && Number.isFinite(transcript[0].start)
    ? transcript[0].start
    : null;
  const hook = placeWindow({ keepSpans, len: 2, preferStart: Math.min(1, D * 0.05), durationSeconds: D });
  const beat = placeWindow({
    keepSpans,
    len: 3,
    preferStart: Math.max(firstWordStart !== null ? firstWordStart : D * 0.4, hook.out + 0.3),
    durationSeconds: D,
  });
  const payoff = placeWindow({
    keepSpans,
    len: 3,
    preferStart: beat.out + Math.max(0.3, (D - beat.out) * 0.3),
    durationSeconds: D,
  });
  return { hook, beat, payoff };
}

function brief({ ingestSummary, intent, audioTreatment }) {
  const v = ingestSummary.primary_video || {};
  return [
    `# Brief: ${PROJECT_ID}`,
    "",
    "## Target",
    `- Platform: ${intent.target_platform} (1080x1920 vertical)`,
    `- Duration: ${intent.target_duration}`,
    `- Source: 1 file, ${ingestSummary.duration_seconds.toFixed(1)}s, ${v.width}x${v.height} ${v.codec}`,
    "",
    "## Hook",
    "Open mid-action on the strongest opening frame; the text hook lands within 700ms.",
    "",
    "## Beats",
    "1. Hook — cold open on the most kinetic moment (2s) with title overlay 'WALKER CUT'",
    "2. Beat — the core development moment (3s)",
    "3. Payoff — hold the resolution (3s)",
    "",
    "## Tone",
    intent.tone,
    "",
    "## Design language",
    "- Typography: headline Anton; captions Inter 900",
    "- Palette: bg #000, text #FFF, accent #FFD60A",
    "- Captions: bold-pop, 64px",
    "- Motion: fast-snap",
    "",
    "## Constraints",
    `- Music/VO: ${intent.music_vo}`,
    `- Audio treatment: ${audioTreatment || "n/a"}`,
    `- Key moments to preserve: ${intent.key_moments}`,
    `- Technical: source ${v.width}x${v.height} → 1080x1920 vertical`,
    "",
  ].join("\n");
}

// Plan-lint-clean storyboard: hook first and ≤3.5s, scene sum == total ==
// target, each scene's single a_roll clip exactly matches the scene target,
// captions only on the speech-overlapping scene (with caption_segments), and
// the optional transition enum exercised on the hook.
function storyboard({ manifestPath, briefPath, sourcePath, windows, speech }) {
  const scenes = [
    {
      scene_id: "s001",
      sequence: 1,
      purpose: "hook",
      target_duration_seconds: 2,
      summary: `Cold open at ${windows.hook.in}s — the most kinetic opening frame.`,
      source_clips: [
        { manifest_file_index: 0, source_path: sourcePath, in_seconds: windows.hook.in, out_seconds: windows.hook.out },
      ],
      overlays: ["text overlay: 'WALKER CUT'"],
      captions: null,
      pacing: "fast",
      transition_in: "cut",
    },
    {
      scene_id: "s002",
      sequence: 2,
      purpose: "beat",
      target_duration_seconds: 3,
      summary: `Core beat at ${windows.beat.in}s${speech ? " — over the first spoken line" : ""}.`,
      source_clips: [
        { manifest_file_index: 0, source_path: sourcePath, in_seconds: windows.beat.in, out_seconds: windows.beat.out },
      ],
      overlays: [],
      captions: speech ? "walker caption pass" : null,
      ...(speech
        ? {
            caption_segments: [
              { text: "walker caption one", start_seconds: round3(windows.beat.in + 0.2), end_seconds: round3(windows.beat.in + 1.4), animation: "word-by-word", style_ref: "bold-pop" },
              { text: "walker caption two", start_seconds: round3(windows.beat.in + 1.5), end_seconds: round3(windows.beat.in + 2.8), emphasis: true, emphasis_words: ["caption"], animation: "pop" },
            ],
          }
        : {}),
      pacing: "medium",
    },
    {
      scene_id: "s003",
      sequence: 3,
      purpose: "payoff",
      target_duration_seconds: 3,
      summary: `Payoff hold at ${windows.payoff.in}s.`,
      source_clips: [
        { manifest_file_index: 0, source_path: sourcePath, in_seconds: windows.payoff.in, out_seconds: windows.payoff.out },
      ],
      overlays: [],
      captions: null,
      pacing: "slow",
    },
  ];
  return {
    schema_version: "1.0",
    project_id: PROJECT_ID,
    generated_at: new Date().toISOString(),
    source: { manifest_path: manifestPath, brief_path: briefPath },
    target: {
      platform: "tiktok", duration_seconds: 8, tone: "cinematic",
      // v3 structured design tokens (mirror of the brief Design language).
      design: {
        palette: { bg: "#000000", text: "#FFFFFF", accent: "#FFD60A" },
        typography: { headline: "Anton", caption: "Inter" },
        caption_style: "bold-pop", motion: "fast-snap", grade: "high-contrast",
      },
    },
    scenes,
    total_target_duration_seconds: 8,
    notes: "Walker fixture — 8s, three beats, hook-first, plan-lint-clean.",
  };
}

// Negative plan-lint fixture: out_seconds past EOF (error) + hook displaced to
// position 2 at 6s (warnings: hook-not-first + scene-sum drift, among others).
function badStoryboard(goodSb, durationSeconds) {
  const bad = JSON.parse(JSON.stringify(goodSb));
  const hook = bad.scenes[0];
  const beat = bad.scenes[1];
  const payoff = bad.scenes[2];
  beat.source_clips[0].out_seconds = round3(durationSeconds + 60); // PLAN_CLIP_OUT_OF_BOUNDS
  hook.target_duration_seconds = 6; // breaks scene-sum vs total (warning)
  bad.scenes = [beat, hook, payoff]; // PLAN_HOOK_NOT_FIRST (warning)
  bad.scenes.forEach((scene, ix) => { scene.sequence = ix + 1; }); // keep schema-valid
  return bad;
}

// QC- and lint-clean composition generated FROM the storyboard object: master
// root with the Rule of Three, one timed class="clip" <video> per scene on
// ./source/<scene_id>-0.mp4 with data-media-start="0" (hyperframes lint
// requires the timing attrs ON the media element — media_missing_data_start),
// caption_segments re-timed onto the timeline at ≥56px, font kit via
// ./fonts.css, and the GSAP-stub timeline registration hyperframes expects.
// opts.fps adds data-fps to the master root (v3 cinematic 24fps path);
// opts.width/height override the output geometry (landscape presets).
function composition(sb, opts = {}) {
  const total = sb.total_target_duration_seconds;
  const W = Number.isFinite(opts.width) ? opts.width : 1080;
  const H = Number.isFinite(opts.height) ? opts.height : 1920;
  const fpsAttr = Number.isFinite(opts.fps) ? `\n     data-fps="${opts.fps}"` : "";
  const sceneDivs = [];
  const captionDivs = [];
  let cursor = 0;
  let captionIx = 0;
  for (const scene of sb.scenes) {
    const clip = scene.source_clips[0];
    sceneDivs.push(
      `  <video id="${scene.scene_id}-0-video" class="clip full-bleed" src="./source/${scene.scene_id}-0.mp4" muted
         data-start="${round3(cursor)}" data-duration="${scene.target_duration_seconds}" data-track-index="0"
         data-media-start="0" data-playback-start="0"></video>`,
    );
    if (Array.isArray(scene.caption_segments)) {
      for (const seg of scene.caption_segments) {
        // caption_segments are SOURCE-time; re-time against the scene's clip.
        const start = round3(cursor + (seg.start_seconds - clip.in_seconds));
        const dur = round3(seg.end_seconds - seg.start_seconds);
        captionIx += 1;
        // An authored caption id binds in COMPOSE QC — stamp data-vob-caption-id
        // (the composer's job); id-less captions stay freeform/unbound.
        const cidAttr = seg.id ? ` data-vob-caption-id="${seg.id}"` : "";
        captionDivs.push(
          `  <div id="caption-${captionIx}" class="clip caption"${cidAttr} data-start="${start}" data-duration="${dur}" data-track-index="3"><span>${seg.text}</span></div>`,
        );
      }
    }
    // Typed overlays (schema 1.2): SCENE-relative timings re-timed to master;
    // each element stamped data-vob-overlay-id (the QC binding). pip carries a
    // <video>; everything else is a class="clip" div.
    if (Array.isArray(scene.overlays)) {
      for (const o of scene.overlays) {
        if (o === null || typeof o !== "object" || Array.isArray(o)) continue;
        const start = round3(cursor + o.start_seconds);
        const dur = round3(o.end_seconds - o.start_seconds);
        if (o.type === "pip") {
          captionDivs.push(
            `  <video id="${o.id}-el" class="pip-inset" src="./source/${scene.scene_id}-0.mp4" muted
         data-vob-overlay-id="${o.id}" data-start="${start}" data-duration="${dur}" data-track-index="${o.track || 1}"
         data-media-start="0" data-playback-start="0"></video>`,
          );
        } else {
          const text = o.content && typeof o.content === "object"
            ? Object.values(o.content).filter((v) => typeof v === "string").join(" — ") || o.type
            : o.type;
          captionDivs.push(
            `  <div id="${o.id}-el" class="clip caption" data-vob-overlay-id="${o.id}" data-start="${start}" data-duration="${dur}" data-track-index="${o.track || 2}"><span>${text}</span></div>`,
          );
        }
      }
    }
    cursor += scene.target_duration_seconds;
  }
  const index = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="./fonts.css">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${W}px; height: ${H}px; background: #000; font-family: "Inter", sans-serif; }
#master-root { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }
video.full-bleed { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
video.pip-inset { position: absolute; right: 40px; top: 120px; width: 30%; border-radius: 16px; object-fit: cover; }
.clip { position: absolute; inset: 0; }
.overlay { display: flex; align-items: center; justify-content: center; pointer-events: none; }
.hook-title {
  color: #fff;
  font-family: "Anton", sans-serif;
  font-size: 128px;
  letter-spacing: 0.01em;
  text-shadow: 0 6px 32px rgba(0,0,0,0.75);
  text-align: center;
  max-width: 920px;
  line-height: 1.0;
  padding: 0 32px;
}
.caption {
  top: auto;
  bottom: 18%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  font-family: "Inter", sans-serif;
  font-size: 64px;
  font-weight: 900;
  color: #fff;
  text-shadow: 0 4px 24px rgba(0,0,0,0.85);
  text-align: center;
}
</style>
</head>
<body>
<div id="master-root"
     data-composition-id="master"
     data-width="${W}"
     data-height="${H}"${fpsAttr}
     data-start="0"
     data-duration="${total}">
${sceneDivs.join("\n")}
  <div id="hook-overlay" class="clip overlay" data-start="0.2" data-duration="1.5" data-track-index="1">
    <h1 class="hook-title">WALKER CUT</h1>
  </div>
${captionDivs.join("\n")}
</div>
<script>
  // Hyperframes expects every composition to register a timeline with a
  // GSAP-like API surface. CSS-only composition -> minimal stub satisfying the
  // methods hyperframes calls during frame capture.
  (function () {
    var MASTER_DURATION = ${total};
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

// Negative QC fixture: the good HTML with (a) an absolute filesystem src,
// (b) the root's data-composition-id removed, and (c) a ./source/ ref matching
// no scene clip or manifest source — three save-time QC errors.
function badComposition(goodFiles) {
  const index = goodFiles["index.html"]
    .replace('\n     data-composition-id="master"', "")
    .replace(
      '<div id="hook-overlay"',
      '<video id="bad-abs" class="full-bleed" src="/absolute/path.mp4" muted data-media-start="0" data-playback-start="0"></video>\n  <video id="bad-ref" class="full-bleed" src="./source/no-such-scene-9.mp4" muted data-media-start="0"></video>\n  <div id="hook-overlay"',
    );
  return { "index.html": index };
}

// Canned classification: route every non-silence segment mechanically —
// has_speech -> aroll_pool, the rest -> broll_index — so INSPECT's
// classification slot is exercised without a model in the loop.
function cannedClassification(segmentsDoc) {
  const aroll = [];
  const broll = [];
  const files = Array.isArray(segmentsDoc.files) ? segmentsDoc.files : [];
  for (const file of files) {
    const segs = Array.isArray(file.segments) ? file.segments : [];
    for (const seg of segs) {
      if (seg.is_silence === true) continue;
      if (seg.has_speech === true) {
        aroll.push({
          file_index: seg.file_index,
          segment_index: seg.index,
          start_seconds: seg.start_seconds,
          end_seconds: seg.end_seconds,
          transcript_span: typeof seg.transcript_text === "string" ? seg.transcript_text : "",
          caption: "walker",
          tags: [],
          confidence: 0.9,
          take_group: null,
          is_best_take: true,
          // v3.2 P3 richer visual fields (exercise validation + counts).
          shot_type: "medium",
          subject_position: "center",
          framing_ok_for_vertical: true,
          camera_movement: "static",
          setting: "studio",
          content_tags: ["walker", "talking-head"],
          on_screen_text: "WALKER",
          action: "speaking to camera",
          content_description: "walker spine shot",
          eyes_to_camera: true,
        });
      } else {
        broll.push({
          file_index: seg.file_index,
          segment_index: seg.index,
          start_seconds: seg.start_seconds,
          end_seconds: seg.end_seconds,
          description: "walker coverage",
          tags: [],
          has_motion: false,
          has_usable_audio: false,
          confidence: 0.9,
          // v3.2 P3 richer visual fields.
          shot_type: "wide",
          subject_position: "none",
          framing_ok_for_vertical: true,
          camera_movement: "static",
          setting: "studio",
          content_tags: ["walker", "coverage"],
          on_screen_text: "WALKER",
          action: "test pattern",
          b_roll_role: "detail",
        });
      }
    }
  }
  // v3.2 P3 multi-file role map — one entry per file (seeded from its prior).
  const fileRoles = files
    .filter((f) => Number.isInteger(f.file_index))
    .map((f) => ({
      file_index: f.file_index,
      role: f.prior === "narration" ? "narration" : (f.prior === "broll" ? "broll" : "mixed"),
      summary: "walker fixture file",
    }));
  return {
    aroll_pool: { segments: aroll },
    broll_index: { clips: broll },
    review: { segments: [] },
    file_roles: fileRoles,
  };
}

// ---------------------------------------------------------------------------
// Fan-out walker phase — the multi-short executable spec. Drives a 2-short
// shorts[] storyboard through PLAN/COMPOSE plus the deliverable record loop;
// asserts the new validation surfaces AND the orchestration bookkeeping
// (identity merge, completeness gate, package guard) without real renders.

function fanoutStoryboard({ projectId, manifestPath, briefPath, sourcePath, windows }) {
  const mkScene = (sceneId, sequence, purpose, w, lenS) => ({
    scene_id: sceneId,
    sequence,
    purpose,
    target_duration_seconds: lenS,
    summary: `${purpose} window at ${w.in}s`,
    source_clips: [
      { manifest_file_index: 0, source_path: sourcePath, in_seconds: w.in, out_seconds: w.out },
    ],
    overlays: purpose === "hook" ? ["text overlay: 'WALKER FANOUT'"] : [],
    captions: null,
    pacing: purpose === "hook" ? "fast" : "medium",
  });
  return {
    schema_version: "1.1",
    project_id: projectId,
    generated_at: new Date().toISOString(),
    source: { manifest_path: manifestPath, brief_path: briefPath },
    target: { platform: "tiktok", duration_seconds: 5, tone: "cinematic" },
    shorts: [
      {
        short_id: "short-1",
        title: "Walker Short One",
        sequence: 1,
        total_target_duration_seconds: 5,
        scenes: [
          mkScene("s101", 1, "hook", windows.h1, 2),
          mkScene("s102", 2, "payoff", windows.p1, 3),
        ],
      },
      {
        short_id: "short-2",
        title: "Walker Short Two",
        sequence: 2,
        total_target_duration_seconds: 5,
        scenes: [
          mkScene("s201", 1, "hook", windows.h2, 2),
          mkScene("s202", 2, "payoff", windows.p2, 3),
        ],
      },
    ],
    notes: "Walker fan-out fixture — 2 shorts × (hook+payoff), plan-lint-clean.",
  };
}

// Per-short composition view: the composition() builder consumes
// scenes + total, which is exactly the timeline projection.
function shortView(fanSb, shortId) {
  const short = fanSb.shorts.find((s) => s.short_id === shortId);
  return { scenes: short.scenes, total_target_duration_seconds: short.total_target_duration_seconds };
}

async function runFanout() {
  const FAN_PROJECT = `${PROJECT_ID}-fanout`;
  console.log(`=== fan-out walker — project: ${FAN_PROJECT}`);

  // 1. init + ingest + INSPECT (same rails as setup, minimal logging)
  try {
    await step("init project", () =>
      call("vob_init_project", { project_id: FAN_PROJECT, target: { format: "tiktok", duration: "4-6s per short" } }),
    );
  } catch (e) {
    if (/already exists/.test(e.message)) console.log("   (already exists — continuing)");
    else throw e;
  }
  const ingest = await step("ingest (ffprobe)", () =>
    call("vob_ingest_file", { project_id: FAN_PROJECT, source_path: SOURCE }),
  );
  const file0 = ingest.files[0];
  await step("transition INGEST→INSPECT", () =>
    call("vob_transition_phase", { project_id: FAN_PROJECT, to_phase: "INSPECT" }),
  );
  const inspect = await step("inspect (ffmpeg + ASR)", () =>
    call("vob_inspect_source", { project_id: FAN_PROJECT }),
  );
  if (inspect.segment_count > 0) {
    const segmentsDoc = JSON.parse(fs.readFileSync(inspect.segments_path, "utf8"));
    await step("save classification (canned)", () =>
      call("vob_save_classification", { project_id: FAN_PROJECT, ...cannedClassification(segmentsDoc) }),
    );
  }
  await step("acknowledge inspect", () => call("vob_acknowledge_inspect", { project_id: FAN_PROJECT }));
  await step("transition INSPECT→INTENT", () =>
    call("vob_transition_phase", { project_id: FAN_PROJECT, to_phase: "INTENT" }),
  );

  // 2. intent — the tester's exact per-short duration form must canonicalize
  //    to { seconds: midpoint, range, per_deliverable:true }.
  const durationRec = await step("record intent target_duration='4-6s per short'", () =>
    call("vob_record_intent_answer", { project_id: FAN_PROJECT, key: "target_duration", value: "4-6s per short" }),
  );
  {
    const v = durationRec.recorded.value;
    assert(v && v.seconds === 5, `expected seconds:5 midpoint, got ${JSON.stringify(v)}`);
    assert(v.range && v.range.min_seconds === 4 && v.range.max_seconds === 6, `expected range {4,6}, got ${JSON.stringify(v.range)}`);
    assert(v.per_deliverable === true, "expected per_deliverable:true");
    console.log(`   canonical: ${JSON.stringify(v)}`);
  }
  for (const [k, val] of Object.entries({
    target_platform: "tiktok",
    tone: "cinematic",
    key_moments: "none in particular",
    music_vo: "neither",
  })) {
    await step(`record intent ${k}`, () =>
      call("vob_record_intent_answer", { project_id: FAN_PROJECT, key: k, value: val }),
    );
  }
  let lastRecord = { missing_required_keys: [] };
  if (inspect.audio_present) {
    const audioTreatment = inspect.speech_detected ? "transcribe_captions" : "keep_ambient";
    lastRecord = await step(`record intent audio_treatment=${audioTreatment}`, () =>
      call("vob_record_intent_answer", { project_id: FAN_PROJECT, key: "audio_treatment", value: audioTreatment }),
    );
    if (audioTreatment === "transcribe_captions") {
      lastRecord = await step("record intent captions_style", () =>
        call("vob_record_intent_answer", { project_id: FAN_PROJECT, key: "captions_style", value: "bold sans, white, pill" }),
      );
    }
  }
  assert(lastRecord.missing_required_keys.length === 0, `intent keys not drained: ${JSON.stringify(lastRecord.missing_required_keys)}`);
  await step("transition INTENT→PLAN", () =>
    call("vob_transition_phase", { project_id: FAN_PROJECT, to_phase: "PLAN" }),
  );

  // 3. brief + fan-out storyboard. Four non-overlapping windows: 2 shorts ×
  //    (2s hook + 3s payoff), spread across the source.
  const D = file0.duration_seconds;
  if (!Number.isFinite(D) || D < 15) throw new Error(`fanout walker needs a source ≥15s (got ${D}s)`);
  const windows = {
    h1: placeWindow({ keepSpans: null, len: 2, preferStart: Math.min(1, D * 0.05), durationSeconds: D }),
    p1: placeWindow({ keepSpans: null, len: 3, preferStart: D * 0.3, durationSeconds: D }),
    h2: placeWindow({ keepSpans: null, len: 2, preferStart: D * 0.55, durationSeconds: D }),
    p2: placeWindow({ keepSpans: null, len: 3, preferStart: D * 0.75, durationSeconds: D }),
  };
  const savedBrief = await step("save brief", () =>
    call("vob_save_brief", {
      project_id: FAN_PROJECT,
      content: `# Brief: ${FAN_PROJECT}\n\n## Target\n- 2 shorts, 4-6s each, tiktok vertical\n\n## Design language\n- Typography: headline Anton; captions Inter 900\n- Palette: bg #000, text #FFF, accent #FFD60A\n- Motion: fast-snap\n`,
    }),
  );
  await step("confirm brief", () => call("vob_confirm_brief", { project_id: FAN_PROJECT }));
  await step("log storyboarder invocation", () =>
    call("vob_log_storyboarder_invocation", { project_id: FAN_PROJECT }),
  );
  const summary0 = await call("vob_read_state_summary", { project_id: FAN_PROJECT });
  assert(
    summary0.target_duration_range
      && summary0.target_duration_range.min_seconds === 4
      && summary0.target_duration_range.per_deliverable === true,
    `summary target_duration_range missing/wrong: ${JSON.stringify(summary0.target_duration_range)}`,
  );
  const fanSb = fanoutStoryboard({
    projectId: FAN_PROJECT,
    manifestPath: summary0.manifest.path,
    briefPath: savedBrief.brief_path,
    sourcePath: file0.path || SOURCE,
    windows,
  });

  // 3a. NEGATIVE: duplicate scene_id across shorts -> coded plan error.
  await step("save storyboard (duplicate scene_id fixture)", async () => {
    const dup = JSON.parse(JSON.stringify(fanSb));
    dup.shorts[1].scenes[0].scene_id = "s101";
    const err = await expectError("vob_save_storyboard", { project_id: FAN_PROJECT, content: dup }, /INVALID_ARGUMENTS/);
    const d = err.details || {};
    assert(
      Array.isArray(d.plan_errors) && d.plan_errors.some((f) => f && f.code === "PLAN_DUPLICATE_SCENE_ID"),
      `expected PLAN_DUPLICATE_SCENE_ID, got ${JSON.stringify(d.plan_errors)}`,
    );
  });

  // 3b. NEGATIVE: shorts[] + top-level scenes is structurally rejected.
  await step("save storyboard (shorts+scenes mutual exclusion)", async () => {
    const both = JSON.parse(JSON.stringify(fanSb));
    both.scenes = [JSON.parse(JSON.stringify(fanSb.shorts[0].scenes[0]))];
    const err = await expectError("vob_save_storyboard", { project_id: FAN_PROJECT, content: both }, /INVALID_ARGUMENTS/);
    const d = err.details || {};
    assert(
      Array.isArray(d.schema_errors) && d.schema_errors.some((m) => /omitted when shorts/.test(String(m))),
      `expected the mutual-exclusion schema error, got ${JSON.stringify(d.schema_errors)}`,
    );
  });

  // 3c. WARNINGS fixture: hook-not-first in short-1 (tagged [short-1]) and a
  //     short total outside the 4-6s intent range — save SUCCEEDS with warnings.
  await step("save storyboard (per-short warnings fixture)", async () => {
    const warny = JSON.parse(JSON.stringify(fanSb));
    const s1 = warny.shorts[0];
    s1.scenes.reverse();
    s1.scenes.forEach((scene, ix) => { scene.sequence = ix + 1; });
    s1.total_target_duration_seconds = 30;
    s1.scenes[0].target_duration_seconds = 15;
    s1.scenes[1].target_duration_seconds = 15;
    const saved = await call("vob_save_storyboard", { project_id: FAN_PROJECT, content: warny });
    const warnings = saved.plan_lint.warnings || [];
    const hookWarn = warnings.find((w) => w.code === "PLAN_HOOK_NOT_FIRST");
    assert(hookWarn && hookWarn.short_id === "short-1" && /^\[short-1\] /.test(hookWarn.message),
      `expected [short-1]-tagged PLAN_HOOK_NOT_FIRST, got ${JSON.stringify(hookWarn)}`);
    const rangeWarn = warnings.find((w) => w.code === "PLAN_SHORT_DURATION_OUT_OF_RANGE");
    assert(rangeWarn && rangeWarn.short_id === "short-1",
      `expected PLAN_SHORT_DURATION_OUT_OF_RANGE for short-1, got ${JSON.stringify(saved.plan_lint.warnings.map((w) => w.code))}`);
    console.log(`\n   warnings as expected: ${warnings.map((w) => w.code).join(", ")}`);
  });

  // 3d. good fan-out storyboard
  const savedSb = await step("save storyboard (fan-out, plan-lint-clean)", () =>
    call("vob_save_storyboard", { project_id: FAN_PROJECT, content: fanSb }),
  );
  assert(savedSb.plan_lint.error_count === 0, "good fan-out storyboard reported plan-lint errors");
  assert(savedSb.short_count === 2 && Array.isArray(savedSb.shorts) && savedSb.shorts.length === 2,
    `expected short_count 2 + shorts digest, got ${JSON.stringify({ short_count: savedSb.short_count, shorts: savedSb.shorts })}`);
  assert(savedSb.scene_count === 4 && savedSb.total_duration_seconds === 10,
    `expected scene_count 4 / total 10, got ${savedSb.scene_count}/${savedSb.total_duration_seconds}`);
  if (savedSb.plan_lint.warning_count > 0) {
    console.log(`   plan-lint warnings (${savedSb.plan_lint.warning_count}): ${(savedSb.plan_lint.warnings || []).map((w) => w.code).join(", ")}`);
  }
  const sbMd = fs.readFileSync(savedSb.markdown_path, "utf8");
  assert(/## Short 1 of 2: short-1/.test(sbMd) && /### Scene 1: s201/.test(sbMd),
    "storyboard.md is missing the per-short sections");
  await step("confirm storyboard", () => call("vob_confirm_storyboard", { project_id: FAN_PROJECT }));

  // 4. COMPOSE entry: the UNION of both shorts' clips materializes.
  const toCompose = await step("transition PLAN→COMPOSE (union pre-cut)", () =>
    call("vob_transition_phase", { project_id: FAN_PROJECT, to_phase: "COMPOSE" }),
  );
  assert(toCompose.clips && toCompose.clips.clip_count === 4,
    `expected 4 materialized clips (union of both shorts), got ${JSON.stringify(toCompose.clips)}`);
  console.log(`   clips: ${toCompose.clips.clip_count}   dir: ${toCompose.clips.clips_dir}`);

  // 5. composition for the active short (short-1)
  await step("log composer invocation", () =>
    call("vob_log_composer_invocation", { project_id: FAN_PROJECT }),
  );
  const comp1 = composition(shortView(fanSb, "short-1"));

  // 5a. NEGATIVE: fan-out storyboard requires short_id on save.
  await step("save composition (missing short_id)", async () => {
    const err = await expectError("vob_save_composition", { project_id: FAN_PROJECT, files: comp1 }, /INVALID_ARGUMENTS/);
    assert(err.details && Array.isArray(err.details.valid_short_ids) && err.details.valid_short_ids.join(",") === "short-1,short-2",
      `expected valid_short_ids, got ${JSON.stringify(err.details)}`);
  });
  await step("save composition (unknown short_id)", () =>
    expectError("vob_save_composition", { project_id: FAN_PROJECT, files: comp1, short_id: "short-9" }, /INVALID_ARGUMENTS/),
  );

  // 5b. NEGATIVE: unresolved ./source/ ref lists the ACTIVE short's clips only.
  await step("save composition (unresolved ref, active-scoped list)", async () => {
    const bad = { "index.html": comp1["index.html"].replace("./source/s102-0.mp4", "./source/no-such-9.mp4") };
    const err = await expectError("vob_save_composition", { project_id: FAN_PROJECT, files: bad, short_id: "short-1" }, /INVALID_ARGUMENTS/);
    const d = err.details || {};
    assert(d.valid_source_refs && Array.isArray(d.valid_source_refs.scene_clips), "no valid_source_refs on unresolved rejection");
    const clips = d.valid_source_refs.scene_clips;
    assert(clips.includes("s101-0.mp4") && clips.includes("s102-0.mp4") && !clips.includes("s201-0.mp4"),
      `expected ONLY short-1 clips in valid refs, got ${JSON.stringify(clips)}`);
    console.log(`\n   active-scoped valid clips: ${clips.join(", ")}`);
  });

  // 5c. cross-short ref WARNS but does not reject (scenes still covered).
  await step("save composition (cross-short ref warns)", async () => {
    const cross = {
      "index.html": comp1["index.html"].replace(
        '<div id="hook-overlay"',
        '<video id="stray" class="clip full-bleed" src="./source/s201-0.mp4" muted data-start="0" data-duration="1" data-track-index="2" data-media-start="0" data-playback-start="0"></video>\n  <div id="hook-overlay"',
      ),
    };
    const saved = await call("vob_save_composition", { project_id: FAN_PROJECT, files: cross, short_id: "short-1" });
    assert(saved.qc.findings.some((f) => f.rule === "vob/cross_short_clip_ref"),
      `expected vob/cross_short_clip_ref warning, got ${JSON.stringify(saved.qc.findings.map((f) => f.rule))}`);
  });

  // 5d. clean short-1 composition + lint (scoped QC re-run) + PREVIEW gate
  const savedComp = await step("save composition (short-1, QC-clean)", () =>
    call("vob_save_composition", { project_id: FAN_PROJECT, files: comp1, short_id: "short-1" }),
  );
  assert(savedComp.short_id === "short-1", "save result missing short_id");
  const lint = await step("lint composition (short-scoped QC)", () =>
    call("vob_lint_composition", { project_id: FAN_PROJECT }),
  );
  if (lint.lint_status === "errors") throw new Error("fan-out lint failed — see report");
  const summary1 = await call("vob_read_state_summary", { project_id: FAN_PROJECT });
  assert(summary1.composition.short_id === "short-1", "summary composition.short_id missing");
  assert(summary1.storyboard.short_count === 2, "summary storyboard.short_count missing");
  await step("transition COMPOSE→PREVIEW", () =>
    call("vob_transition_phase", { project_id: FAN_PROJECT, to_phase: "PREVIEW" }),
  );

  // 5e. THE ACTIVE-SHORT CYCLE — the defining fan-out move: back-edge to
  //     COMPOSE, save the NEXT short's composition, and the short_id stamp +
  //     scoped lint must rotate with it.
  await step("back-edge PREVIEW→COMPOSE (next short)", () =>
    call("vob_transition_phase", { project_id: FAN_PROJECT, to_phase: "COMPOSE" }),
  );
  const comp2 = composition(shortView(fanSb, "short-2"));
  const savedComp2 = await step("save composition (short-2, active-short rotation)", () =>
    call("vob_save_composition", { project_id: FAN_PROJECT, files: comp2, short_id: "short-2" }),
  );
  assert(savedComp2.short_id === "short-2", "short-2 save result missing short_id");
  const lint2 = await step("lint composition (re-scoped to short-2)", () =>
    call("vob_lint_composition", { project_id: FAN_PROJECT }),
  );
  if (lint2.lint_status === "errors") throw new Error("short-2 lint failed — see report");
  const summary1b = await call("vob_read_state_summary", { project_id: FAN_PROJECT });
  assert(summary1b.composition.short_id === "short-2",
    `composition.short_id did not rotate to short-2, got ${summary1b.composition.short_id}`);
  await step("transition COMPOSE→PREVIEW (short-2)", () =>
    call("vob_transition_phase", { project_id: FAN_PROJECT, to_phase: "PREVIEW" }),
  );

  // 6. deliverable loop without renders: record short-1 from its pre-cut clip
  //    (stands in for a confirmed render; origin stays "external" since it is
  //    not under renders/), normalize on.
  const clipsDir = toCompose.clips.clips_dir;
  const fakeFinal1 = path.join(clipsDir, "s101-0.mp4");
  assert(fs.existsSync(fakeFinal1), `expected pre-cut clip at ${fakeFinal1}`);

  await step("import deliverable (missing short_id rejected)", () =>
    expectError(
      "vob_import_deliverable",
      { project_id: FAN_PROJECT, deliverables: [{ path: fakeFinal1, title: "Walker Short One" }] },
      /INVALID_ARGUMENTS/,
    ),
  );

  const imp1 = await step("import deliverable short-1 (normalize)", () =>
    call("vob_import_deliverable", {
      project_id: FAN_PROJECT,
      deliverables: [{ path: fakeFinal1, title: "Walker Short One", short_id: "short-1" }],
      normalize: true,
    }),
  );
  {
    const rec = imp1.deliverables[0];
    assert(rec.short_id === "short-1" && rec.origin === "external", `unexpected record: ${JSON.stringify(rec)}`);
    // Source-aware loudnorm assert: when the source HAS audio (audio_treatment
    // keeps it), a no_audio skip would mean a probe/materialization bug.
    const okSkips = inspect.audio_present
      ? ["silent_audio", "already_within_tolerance"]
      : ["no_audio", "silent_audio", "already_within_tolerance"];
    assert(rec.loudnorm && (rec.loudnorm.applied === true || okSkips.includes(rec.loudnorm.skipped_reason)),
      `unexpected loudnorm outcome (audio_present=${inspect.audio_present}): ${JSON.stringify(rec.loudnorm)}`);
    assert(fs.existsSync(imp1.deliverables_manifest_path), "deliverables/manifest.json not written");
    assert(imp1.phase === "PACKAGE", `expected phase PACKAGE after import, got ${imp1.phase}`);
    console.log(`   loudnorm: ${rec.loudnorm.applied ? "applied" : `skipped (${rec.loudnorm.skipped_reason})`}   origin: ${rec.origin}`);
  }

  // 6a. package_output refuses on a fan-out storyboard — BEFORE wiping anything.
  await step("package_output refused (fan-out guard)", async () => {
    const err = await expectError("vob_package_output", { project_id: FAN_PROJECT }, /STATE_CONFLICT/);
    assert(err.details && err.details.fan_out === true, `expected fan_out:true details, got ${JSON.stringify(err.details)}`);
  });

  // 6b. PACKAGE→ITERATE blocks while short-2 has no record.
  await step("PACKAGE→ITERATE blocked (shorts_missing_deliverables)", async () => {
    const err = await expectError(
      "vob_transition_phase",
      { project_id: FAN_PROJECT, to_phase: "ITERATE" },
      /STATE_CONFLICT|GATE/,
    );
    const text = JSON.stringify(err.details || {}) + err.message;
    assert(/shorts_missing_deliverables/.test(text) && /short-2/.test(text),
      `expected shorts_missing_deliverables naming short-2, got ${text.slice(0, 300)}`);
  });

  // 6c. revision semantics: re-import short-1 under a NEW title — the record
  //     is REPLACED (merge by short_id), never duplicated.
  const imp1b = await step("re-import short-1 (revision replaces record)", () =>
    call("vob_import_deliverable", {
      project_id: FAN_PROJECT,
      deliverables: [{ path: fakeFinal1, title: "Walker Short One v2", short_id: "short-1" }],
      normalize: false,
      set_phase: false,
    }),
  );
  assert(imp1b.total_deliverables === 1, `expected 1 total deliverable after revision, got ${imp1b.total_deliverables}`);

  // 6d. record short-2 → completeness satisfied → ITERATE + finalize. The
  //     fake final sits under the session's renders/ so the provenance branch
  //     stamps origin:"render" (the on-rails record path).
  const rendersFakeDir = path.join(path.dirname(clipsDir), "..", "renders");
  fs.mkdirSync(rendersFakeDir, { recursive: true });
  const fakeFinal2 = path.join(rendersFakeDir, "final-walker-fanout.mp4");
  fs.copyFileSync(path.join(clipsDir, "s201-0.mp4"), fakeFinal2);
  const imp2 = await step("import deliverable short-2 (origin:render)", () =>
    call("vob_import_deliverable", {
      project_id: FAN_PROJECT,
      deliverables: [{ path: fakeFinal2, title: "Walker Short Two", short_id: "short-2" }],
      normalize: true,
    }),
  );
  assert(imp2.total_deliverables === 2, `expected 2 total deliverables, got ${imp2.total_deliverables}`);
  assert(imp2.deliverables[0].origin === "render",
    `expected origin:"render" for a renders/ file, got ${imp2.deliverables[0].origin}`);
  const summary2 = await call("vob_read_state_summary", { project_id: FAN_PROJECT });
  assert(Array.isArray(summary2.deliverables) && summary2.deliverables.length === 2
    && summary2.deliverables.map((d) => d.short_id).sort().join(",") === "short-1,short-2",
    `summary deliverables digest wrong: ${JSON.stringify(summary2.deliverables)}`);
  await step("transition PACKAGE→ITERATE", () =>
    call("vob_transition_phase", { project_id: FAN_PROJECT, to_phase: "ITERATE" }),
  );
  await step("finalize iteration", () => call("vob_finalize_iteration", { project_id: FAN_PROJECT }));

  const final = await call("vob_read_state_summary", { project_id: FAN_PROJECT });
  console.log(`\n=== fan-out final phase: ${final.phase}   deliverables: ${final.deliverable_count}   project: ${final.project_id}`);
}

// ---------------------------------------------------------------------------
// v3 shared rails: init → ingest → INSPECT (canned classification + ack) →
// INTENT (drain required + conditional keys) → PLAN (brief saved + confirmed).
// Every v3 walker phase (general/longform/overlays/gaps) boots through this.

async function bootstrapToPlan({ projectId, target, intentAnswers, briefBody }) {
  try {
    await step("init project", () =>
      call("vob_init_project", { project_id: projectId, target }),
    );
  } catch (e) {
    if (/already exists/.test(e.message)) console.log("   (already exists — continuing)");
    else throw e;
  }
  const ingest = await step("ingest (ffprobe)", () =>
    call("vob_ingest_file", { project_id: projectId, source_path: SOURCE }),
  );
  const file0 = ingest.files[0];
  await step("transition INGEST→INSPECT", () =>
    call("vob_transition_phase", { project_id: projectId, to_phase: "INSPECT" }),
  );
  const inspect = await step("inspect (ffmpeg + ASR)", () =>
    call("vob_inspect_source", { project_id: projectId }),
  );
  // v3.2 INSPECT deep-inspect signals (P1 alignment marker + P2 audio analysis).
  // Degrade-aware: transcript_aligned is true only when an alignment backend
  // (whisperx) is installed — the assertions hold either way.
  await step("v3.2 inspect signals (P1 transcript_aligned + P2 audio)", async () => {
    assert(typeof inspect.transcript_aligned === "boolean",
      `transcript_aligned must be boolean, got ${JSON.stringify(inspect.transcript_aligned)}`);
    if (inspect.audio_present) {
      assert(inspect.audio && Array.isArray(inspect.audio.files) && inspect.audio.files.length > 0,
        `audio_present but no audio summary: ${JSON.stringify(inspect.audio)}`);
      assert(typeof inspect.audio_analysis_path === "string" && fs.existsSync(inspect.audio_analysis_path),
        `audio_analysis.json missing at ${inspect.audio_analysis_path}`);
      const aa = JSON.parse(fs.readFileSync(inspect.audio_analysis_path, "utf8"));
      assert(aa.normalization && Array.isArray(aa.normalization.files),
        "audio_analysis.json lacks a normalization advisory");
      assert(aa.target_lufs === -14, `expected −14 LUFS target, got ${aa.target_lufs}`);
      assert("clean_audio_source" in aa, "audio_analysis.json lacks clean_audio_source");
      // P2 per-segment loudness proxy: additive field on every segment.
      const segDoc = JSON.parse(fs.readFileSync(inspect.segments_path, "utf8"));
      const segs = segDoc.files.flatMap((f) => f.segments || []);
      assert(segs.length === 0 || segs.every((s) => "loudness_lufs_approx" in s),
        "segments missing the loudness_lufs_approx field");
      // P2.1 manifest enrichment carried per audio stream.
      const audioFile = ingest.files.find((f) => f && Array.isArray(f.audio_streams_detail) && f.audio_streams_detail.length > 0);
      assert(audioFile, "no manifest file carries audio_streams_detail");
      assert(Number.isFinite(audioFile.audio_streams_detail[0].channels),
        `audio_streams_detail[0].channels not captured: ${JSON.stringify(audioFile.audio_streams_detail[0])}`);
    }
  });
  if (inspect.segment_count > 0) {
    const segmentsDoc = JSON.parse(fs.readFileSync(inspect.segments_path, "utf8"));
    const cls = await step("save classification (canned)", () =>
      call("vob_save_classification", { project_id: projectId, ...cannedClassification(segmentsDoc) }),
    );
    // v3.2 P3: richer-tagging coverage counts + the multi-file role map, both on
    // the save return and surfaced by read_state_summary (quality notes, no gate).
    await step("v3.2 classification tagging (P3 counts + file_roles)", async () => {
      const fileCount = Array.isArray(segmentsDoc.files) ? segmentsDoc.files.length : 0;
      assert(cls.file_role_count === fileCount,
        `file_role_count ${cls.file_role_count} != file count ${fileCount}`);
      assert(Array.isArray(cls.file_roles) && cls.file_roles.length === fileCount,
        "classification return missing file_roles[]");
      if ((cls.aroll_count + cls.broll_count) > 0) {
        assert(cls.content_tagged_count > 0, `content_tagged_count should be >0, got ${cls.content_tagged_count}`);
        assert(cls.on_screen_text_count > 0, `on_screen_text_count should be >0, got ${cls.on_screen_text_count}`);
      }
      const s = await call("vob_read_state_summary", { project_id: projectId });
      const sc = s.inspect && s.inspect.classification;
      assert(sc && Number.isInteger(sc.content_tagged_count) && Number.isInteger(sc.on_screen_text_count) && Number.isInteger(sc.file_role_count),
        `read_state_summary classification missing P3 counts: ${JSON.stringify(sc)}`);
    });
  }
  await step("acknowledge inspect", () => call("vob_acknowledge_inspect", { project_id: projectId }));
  await step("transition INSPECT→INTENT", () =>
    call("vob_transition_phase", { project_id: projectId, to_phase: "INTENT" }),
  );

  let lastRecord = { missing_required_keys: [] };
  for (const [k, v] of Object.entries(intentAnswers)) {
    lastRecord = await step(`record intent ${k}`, () =>
      call("vob_record_intent_answer", { project_id: projectId, key: k, value: v }),
    );
  }
  if (inspect.audio_present) {
    const audioTreatment = inspect.speech_detected ? "transcribe_captions" : "keep_ambient";
    lastRecord = await step(`record intent audio_treatment=${audioTreatment}`, () =>
      call("vob_record_intent_answer", { project_id: projectId, key: "audio_treatment", value: audioTreatment }),
    );
    if (audioTreatment === "transcribe_captions") {
      lastRecord = await step("record intent captions_style", () =>
        call("vob_record_intent_answer", { project_id: projectId, key: "captions_style", value: "bold sans, white, pill" }),
      );
    }
  }
  assert(
    Array.isArray(lastRecord.missing_required_keys) && lastRecord.missing_required_keys.length === 0,
    `intent keys not drained: ${JSON.stringify(lastRecord.missing_required_keys)}`,
  );
  await step("transition INTENT→PLAN", () =>
    call("vob_transition_phase", { project_id: projectId, to_phase: "PLAN" }),
  );
  const savedBrief = await step("save brief", () =>
    call("vob_save_brief", { project_id: projectId, content: briefBody }),
  );
  await step("confirm brief", () => call("vob_confirm_brief", { project_id: projectId }));
  const summary = await call("vob_read_state_summary", { project_id: projectId });
  return { ingest, file0, inspect, savedBrief, summary };
}

// ---------------------------------------------------------------------------
// v3 `general` walker phase — the P1 executable spec: video_type preset
// resolution (derived / intent / env / user file), summary + doctor surfaces,
// lint-ruleset gating at save (chaptered vs retention), and the target.fps →
// data-fps QC path. No renders.

function generalScene({ sceneId, sequence, purpose, win, targetSeconds, sourcePath, pacing = "medium" }) {
  return {
    scene_id: sceneId,
    sequence,
    purpose,
    target_duration_seconds: targetSeconds,
    summary: `${purpose} window at ${win.in}s`,
    source_clips: [
      { manifest_file_index: 0, source_path: sourcePath, in_seconds: win.in, out_seconds: win.out },
    ],
    overlays: [],
    captions: null,
    pacing,
  };
}

async function runGeneral() {
  const GEN = `${PROJECT_ID}-general`;
  const vtLib = require("../mcp/lib/video-types.js");
  console.log(`=== v3 general walker (presets/format) — project: ${GEN}`);

  const boot = await bootstrapToPlan({
    projectId: GEN,
    target: { format: "youtube", duration: "12 minutes" },
    intentAnswers: {
      target_platform: "youtube",
      target_duration: "12 minutes",
      tone: "calm documentary",
      key_moments: "none in particular",
      music_vo: "neither",
    },
    briefBody: `# Brief: ${GEN}\n\n## Target\n- long-form youtube, ~12 minutes\n\n## Design language\n- Typography: headline Hanken Grotesk; captions Inter\n- Palette: bg #000, text #FFF\n- Motion: medium\n`,
  });
  const D = boot.file0.duration_seconds;
  const srcPath = boot.file0.path || SOURCE;

  // 1. Derivation: youtube + 12 min ⇒ long-form (no video_type answered).
  await step("video_type derived (youtube + 12min ⇒ long-form)", async () => {
    const v = boot.summary.video_type;
    assert(v && v.canonical === "long-form" && v.source === "derived",
      `expected derived long-form, got ${JSON.stringify(v)}`);
    assert(v.lint_ruleset === "chaptered" && v.segmentation === "auto" && v.clean_cut === true,
      `unexpected long-form preset digest: ${JSON.stringify(v)}`);
  });

  // 1b. Guided-INTENT optional keys (design_language / pacing_intent / hook_intent):
  //     recordable as plain free-text, NEVER gate (absent from missing_required_keys),
  //     and ride through the summary's intent.answers verbatim so PLAN/COMPOSE read them.
  await step("optional guided-intent keys record, never gate, ride through", async () => {
    const guided = {
      design_language: "headline Anton; captions Inter 900; bg #000 / text #FFF / accent #FF3B30; bold-pop ALL-CAPS captions",
      pacing_intent: "fast, tighter on the back half",
      hook_intent: "open on the result at 1:10",
      broll_intent: "illustrative — cut away when it depicts the point",
    };
    for (const [k, v] of Object.entries(guided)) {
      const rec = await call("vob_record_intent_answer", { project_id: GEN, key: k, value: v });
      assert(typeof rec.recorded.value === "string" && rec.recorded.value === v,
        `optional key ${k} must stay a plain free-text string (not canonicalized to an object), got ${JSON.stringify(rec.recorded.value)}`);
      assert(!(rec.missing_required_keys || []).includes(k),
        `optional key ${k} must never appear in missing_required_keys, got ${JSON.stringify(rec.missing_required_keys)}`);
    }
    const s = await call("vob_read_state_summary", { project_id: GEN });
    for (const [k, v] of Object.entries(guided)) {
      assert(s.intent.answers[k] === v,
        `summary must echo optional key ${k} verbatim, got ${JSON.stringify(s.intent.answers[k])}`);
    }
  });

  // 2. Free-text intent answer canonicalizes; summary rotates to source:intent;
  //    the answers echo stays lean ({raw, canonical} — no preset blob).
  await step("record video_type 'a cinematic montage please'", async () => {
    const rec = await call("vob_record_intent_answer", { project_id: GEN, key: "video_type", value: "a cinematic montage please" });
    assert(rec.recorded.value && rec.recorded.value.canonical === "cinematic",
      `expected canonical cinematic, got ${JSON.stringify(rec.recorded.value)}`);
    const s = await call("vob_read_state_summary", { project_id: GEN });
    assert(s.video_type.canonical === "cinematic" && s.video_type.source === "intent" && s.video_type.clean_cut === false,
      `summary did not rotate to intent/cinematic: ${JSON.stringify(s.video_type)}`);
    const echo = s.intent.answers.video_type;
    assert(echo && echo.raw && echo.canonical === "cinematic" && !("preset" in echo),
      `answers echo should be lean {raw,canonical}: ${JSON.stringify(echo)}`);
  });

  // 3. Env override beats the recorded answer.
  await step("VOB_VIDEO_TYPE env override wins", async () => {
    process.env.VOB_VIDEO_TYPE = "tutorial";
    try {
      const s = await call("vob_read_state_summary", { project_id: GEN });
      assert(s.video_type.canonical === "tutorial" && s.video_type.source === "env",
        `expected env/tutorial, got ${JSON.stringify(s.video_type)}`);
    } finally {
      delete process.env.VOB_VIDEO_TYPE;
    }
  });

  // 4. User preset file: a new name based on `general`, selectable as an
  //    answer, reported by doctor (table + per-project resolution).
  const tmpTypes = path.join(require("os").tmpdir(), `vob-walker-video-types-${process.pid}.json`);
  await step("user preset file (course-module) + doctor report", async () => {
    fs.writeFileSync(tmpTypes, JSON.stringify({
      "course-module": { platform_default: "tutorial", lint_ruleset: "chaptered", render: { segmentation: "manual" } },
    }));
    process.env.VOB_VIDEO_TYPES_FILE = tmpTypes;
    vtLib._reloadForTests();
    try {
      const rec = await call("vob_record_intent_answer", { project_id: GEN, key: "video_type", value: "course-module" });
      assert(rec.recorded.value.canonical === "course-module",
        `expected canonical course-module, got ${JSON.stringify(rec.recorded.value)}`);
      const s = await call("vob_read_state_summary", { project_id: GEN });
      assert(s.video_type.canonical === "course-module" && s.video_type.platform_default === "tutorial"
        && s.video_type.segmentation === "manual",
        `user preset not resolved: ${JSON.stringify(s.video_type)}`);
      const doc = await call("vob_doctor", { project_id: GEN });
      assert(doc.video_types && doc.video_types.user_defined.includes("course-module"),
        `doctor video_types missing user preset: ${JSON.stringify(doc.video_types && doc.video_types.user_defined)}`);
      assert(doc.video_types.project && doc.video_types.project.canonical === "course-module",
        `doctor project resolution wrong: ${JSON.stringify(doc.video_types.project)}`);
    } finally {
      delete process.env.VOB_VIDEO_TYPES_FILE;
      vtLib._reloadForTests();
      try { fs.rmSync(tmpTypes, { force: true }); } catch {}
    }
  });

  // 5. Ruleset gating, chaptered side: hook-not-first DOES NOT warn; an 8-min
  //    chaptered plan without segments[] DOES warn PLAN_CHAPTERS_MISSING.
  await step("record video_type long-form", () =>
    call("vob_record_intent_answer", { project_id: GEN, key: "video_type", value: "long-form" }),
  );
  const w1 = placeWindow({ keepSpans: null, len: 3, preferStart: D * 0.1, durationSeconds: D });
  const w2 = placeWindow({ keepSpans: null, len: 3, preferStart: D * 0.4, durationSeconds: D });
  const w3 = placeWindow({ keepSpans: null, len: 3, preferStart: D * 0.7, durationSeconds: D });
  const longSb = {
    schema_version: "1.0",
    project_id: GEN,
    generated_at: new Date().toISOString(),
    source: { manifest_path: boot.summary.manifest.path, brief_path: boot.savedBrief.brief_path },
    target: { platform: "youtube_long", duration_seconds: 720, tone: "calm documentary" },
    scenes: [
      generalScene({ sceneId: "g001", sequence: 1, purpose: "beat", win: w1, targetSeconds: 160, sourcePath: srcPath }),
      generalScene({ sceneId: "g002", sequence: 2, purpose: "beat", win: w2, targetSeconds: 160, sourcePath: srcPath }),
      generalScene({ sceneId: "g003", sequence: 3, purpose: "payoff", win: w3, targetSeconds: 160, sourcePath: srcPath }),
    ],
    total_target_duration_seconds: 480,
    notes: "general walker — chaptered ruleset fixture (no hook scene on purpose).",
  };
  await step("save storyboard (chaptered: no hook warning, chapters-missing warns)", async () => {
    const saved = await call("vob_save_storyboard", { project_id: GEN, content: longSb });
    const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
    assert(!codes.includes("PLAN_HOOK_NOT_FIRST"),
      `chaptered ruleset must not warn hook-not-first, got ${JSON.stringify(codes)}`);
    assert(codes.includes("PLAN_CHAPTERS_MISSING"),
      `expected PLAN_CHAPTERS_MISSING on a 480s chaptered plan with no segments[], got ${JSON.stringify(codes)}`);
    console.log(`\n   chaptered warnings: ${codes.join(", ")}`);
  });

  // 6. Ruleset gating, retention side: the SAME document under social-short
  //    brings the hook heuristics back and drops the chapter rule.
  await step("retention contrast (same doc, video_type social-short)", async () => {
    await call("vob_record_intent_answer", { project_id: GEN, key: "video_type", value: "social-short" });
    const saved = await call("vob_save_storyboard", { project_id: GEN, content: longSb });
    const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
    assert(codes.includes("PLAN_HOOK_NOT_FIRST"),
      `retention ruleset must warn hook-not-first, got ${JSON.stringify(codes)}`);
    assert(!codes.includes("PLAN_CHAPTERS_MISSING"),
      `retention ruleset must not run chapter rules, got ${JSON.stringify(codes)}`);
  });

  // 6b. v3 PLAN levers — design tokens, pacing arc, caption plan. social-short
  //     (retention) is the active video_type here.
  await step("design_default surfaces (summary + doctor)", async () => {
    const s = await call("vob_read_state_summary", { project_id: GEN });
    const dd = s.video_type.design_default;
    assert(dd && dd.caption_style && dd.typography && dd.palette,
      `summary video_type.design_default missing: ${JSON.stringify(dd)}`);
    const doc = await call("vob_doctor", { project_id: GEN });
    const social = (doc.video_types.presets || []).find((p) => p.name === "social-short");
    assert(social && social.design_default && social.design_default.caption_style === "bold-pop",
      `doctor preset design_default missing/wrong: ${JSON.stringify(social && social.design_default)}`);
  });

  const dw = [0.1, 0.3, 0.5, 0.7].map((f) => placeWindow({ keepSpans: null, len: 2, preferStart: D * f, durationSeconds: D }));
  const genSb = (extra) => ({
    schema_version: "1.0", project_id: GEN, generated_at: new Date().toISOString(),
    source: { manifest_path: boot.summary.manifest.path, brief_path: boot.savedBrief.brief_path },
    target: { platform: "tiktok", duration_seconds: 8, tone: "energetic" },
    total_target_duration_seconds: 8,
    ...extra,
  });

  await step("pacing-arc: monotone (4× medium) warns; design tokens clean", async () => {
    const sb = genSb({
      target: {
        platform: "tiktok", duration_seconds: 8, tone: "energetic",
        design: { palette: { bg: "#000", accent: "#FFD60A" }, typography: { headline: "Anton", caption: "Inter" }, caption_style: "bold-pop", motion: "fast-snap" },
      },
      scenes: [
        generalScene({ sceneId: "m001", sequence: 1, purpose: "hook", win: dw[0], targetSeconds: 2, sourcePath: srcPath, pacing: "medium" }),
        generalScene({ sceneId: "m002", sequence: 2, purpose: "beat", win: dw[1], targetSeconds: 2, sourcePath: srcPath, pacing: "medium" }),
        generalScene({ sceneId: "m003", sequence: 3, purpose: "beat", win: dw[2], targetSeconds: 2, sourcePath: srcPath, pacing: "medium" }),
        generalScene({ sceneId: "m004", sequence: 4, purpose: "payoff", win: dw[3], targetSeconds: 2, sourcePath: srcPath, pacing: "medium" }),
      ],
    });
    const saved = await call("vob_save_storyboard", { project_id: GEN, content: sb });
    assert(saved.plan_lint.error_count === 0, "design/pacing fixture reported plan-lint errors");
    const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
    assert(codes.includes("PLAN_PACING_MONOTONE"), `expected PLAN_PACING_MONOTONE, got ${JSON.stringify(codes)}`);
    assert(!codes.includes("PLAN_RHYTHM_ARC_INVERTED"), `all-equal pacing is not inverted, got ${JSON.stringify(codes)}`);
    // The structured design block validates and never lints.
    const md = fs.readFileSync(saved.markdown_path, "utf8");
    assert(/- Design:/.test(md) && /caption style bold-pop/.test(md), "storyboard.md missing the Design block");
  });

  const invertedSb = genSb({
    target: { platform: "tiktok", duration_seconds: 6, tone: "energetic" },
    total_target_duration_seconds: 6,
    scenes: [
      generalScene({ sceneId: "i001", sequence: 1, purpose: "hook", win: dw[0], targetSeconds: 2, sourcePath: srcPath, pacing: "slow" }),
      generalScene({ sceneId: "i002", sequence: 2, purpose: "beat", win: dw[1], targetSeconds: 2, sourcePath: srcPath, pacing: "fast" }),
      generalScene({ sceneId: "i003", sequence: 3, purpose: "payoff", win: dw[2], targetSeconds: 2, sourcePath: srcPath, pacing: "fast" }),
    ],
  });
  await step("pacing-arc: inverted (slow hook → fast) warns under retention", async () => {
    const saved = await call("vob_save_storyboard", { project_id: GEN, content: invertedSb });
    const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
    assert(codes.includes("PLAN_RHYTHM_ARC_INVERTED"), `expected PLAN_RHYTHM_ARC_INVERTED, got ${JSON.stringify(codes)}`);
  });
  await step("pacing-arc: inverted is GATED OFF under the cinematic ruleset", async () => {
    process.env.VOB_VIDEO_TYPE = "cinematic";
    try {
      const saved = await call("vob_save_storyboard", { project_id: GEN, content: invertedSb });
      const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
      assert(!codes.includes("PLAN_RHYTHM_ARC_INVERTED"),
        `cinematic ruleset must gate off PLAN_RHYTHM_ARC_INVERTED, got ${JSON.stringify(codes)}`);
    } finally {
      delete process.env.VOB_VIDEO_TYPE;
    }
  });

  await step("caption-plan: chunk-too-long + emphasis-not-in-text + timing-drift warn", async () => {
    const win = dw[0];
    // captions:null avoids the captions-on-silent ERROR; caption_segments lint
    // is independent of the `captions` summary string.
    const capScene = {
      ...generalScene({ sceneId: "cap1", sequence: 1, purpose: "hook", win, targetSeconds: 2, sourcePath: srcPath, pacing: "fast" }),
      caption_segments: [
        { text: "this kinetic caption chunk has far too many words to read", start_seconds: round3(win.in + 0.1), end_seconds: round3(win.in + 1.2) },
        { text: "short and sweet", start_seconds: round3(win.in + 1.3), end_seconds: round3(win.in + 1.9), emphasis_words: ["absent"] },
        { text: "way off", start_seconds: round3(win.out + 5), end_seconds: round3(win.out + 6) },
      ],
    };
    const saved = await call("vob_save_storyboard", { project_id: GEN, content: genSb({ target: { platform: "tiktok", duration_seconds: 2, tone: "energetic" }, total_target_duration_seconds: 2, scenes: [capScene] }) });
    const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
    for (const code of ["PLAN_CAPTION_CHUNK_TOO_LONG", "PLAN_CAPTION_EMPHASIS_NOT_IN_TEXT", "PLAN_CAPTION_TIMING_DRIFT"]) {
      assert(codes.includes(code), `expected ${code}, got ${JSON.stringify(codes.filter((c) => /CAPTION/.test(c)))}`);
    }
    console.log(`\n   caption warnings: ${codes.filter((c) => /CAPTION/.test(c)).join(", ")}`);
  });

  // caption-plan ↔ INSPECT P1: word-level animation (karaoke/word-by-word) needs
  // forced-aligned word timing. Host-robust — read the ACTUAL transcript_aligned
  // and assert conditionally (warns iff unaligned); "pop" never trips it anywhere.
  await step("caption-plan: karaoke gated by transcript_aligned (P1)", async () => {
    const sCheck = await call("vob_read_state_summary", { project_id: GEN });
    const aligned = !!(sCheck.inspect && sCheck.inspect.transcript_aligned === true);
    const win = dw[0];
    const mkScene = (sceneId, animation) => ({
      ...generalScene({ sceneId, sequence: 1, purpose: "hook", win, targetSeconds: 2, sourcePath: srcPath, pacing: "fast" }),
      // segment INSIDE the clip window so PLAN_CAPTION_TIMING_DRIFT can't confound
      caption_segments: [
        { text: "watch this", start_seconds: round3(win.in + 0.2), end_seconds: round3(win.in + 1.0), animation },
      ],
    });
    const wrap = (scene) => genSb({ target: { platform: "tiktok", duration_seconds: 2, tone: "energetic" }, total_target_duration_seconds: 2, scenes: [scene] });

    const karCodes = ((await call("vob_save_storyboard", { project_id: GEN, content: wrap(mkScene("kar1", "karaoke")) })).plan_lint.warnings || []).map((w) => w.code);
    if (aligned) {
      assert(!karCodes.includes("PLAN_CAPTION_KARAOKE_UNALIGNED"),
        `aligned transcript must NOT warn karaoke-unaligned, got ${JSON.stringify(karCodes)}`);
    } else {
      assert(karCodes.includes("PLAN_CAPTION_KARAOKE_UNALIGNED"),
        `unaligned transcript must warn karaoke-unaligned, got ${JSON.stringify(karCodes)}`);
    }
    // Control: chunk-level "pop" never trips the alignment lint, on any host.
    const popCodes = ((await call("vob_save_storyboard", { project_id: GEN, content: wrap(mkScene("pop1", "pop")) })).plan_lint.warnings || []).map((w) => w.code);
    assert(!popCodes.includes("PLAN_CAPTION_KARAOKE_UNALIGNED"),
      `"pop" animation must never trip karaoke-unaligned, got ${JSON.stringify(popCodes)}`);
    console.log(`\n   transcript_aligned=${aligned} → karaoke ${aligned ? "clean" : "WARNS"}; pop clean`);
  });

  // 6b. Per-clip speed (constant): effectiveClipDuration routes the raw-span lints
  //     to OUTPUT time, and the materializer bakes setpts/atempo so the FILE length
  //     becomes (out-in)/speed. target_duration_seconds is authored as OUTPUT time.
  await step("speed: 2x authored at output time is plan-clean; @1x mismatches", async () => {
    const win = dw[0];
    const eff = round3((win.out - win.in) / 2);
    const mk = (speed) => {
      const sc = generalScene({ sceneId: "spd1", sequence: 1, purpose: "beat", win, targetSeconds: eff, sourcePath: srcPath, pacing: "fast" });
      sc.source_clips[0].speed = speed;
      return genSb({ target: { platform: "tiktok", duration_seconds: eff, tone: "energetic" }, total_target_duration_seconds: eff, scenes: [sc] });
    };
    const clean = ((await call("vob_save_storyboard", { project_id: GEN, content: mk(2) })).plan_lint.warnings || []).map((w) => w.code);
    assert(!clean.includes("PLAN_SCENE_CLIP_SUM_MISMATCH"),
      `2x clip authored at output time must be clean, got ${JSON.stringify(clean)}`);
    const mism = ((await call("vob_save_storyboard", { project_id: GEN, content: mk(1) })).plan_lint.warnings || []).map((w) => w.code);
    assert(mism.includes("PLAN_SCENE_CLIP_SUM_MISMATCH"),
      `same raw clip @1x vs the halved target must warn PLAN_SCENE_CLIP_SUM_MISMATCH, got ${JSON.stringify(mism)}`);
  });
  await step("speed: out-of-range rejected; real 2x materialize → file ≈ (out-in)/speed", async () => {
    const badWin = dw[1];
    const bad = generalScene({ sceneId: "spdbad", sequence: 1, purpose: "beat", win: badWin, targetSeconds: round3(badWin.out - badWin.in), sourcePath: srcPath });
    bad.source_clips[0].speed = 9; // outside [0.25, 4]
    await expectError("vob_save_storyboard",
      { project_id: GEN, content: genSb({ target: { platform: "tiktok", duration_seconds: 2, tone: "energetic" }, total_target_duration_seconds: round3(badWin.out - badWin.in), scenes: [bad] }) },
      /INVALID_ARGUMENTS/);
    const { materializeSceneClips } = require("../mcp/lib/clip-materialize.js");
    const { spawnSync } = require("child_process");
    const w = dw[2];
    const raw = round3(w.out - w.in);
    const eff = round3(raw / 2);
    const sb = {
      schema_version: "1.0", project_id: GEN, generated_at: new Date().toISOString(),
      source: { manifest_path: boot.summary.manifest.path, brief_path: boot.savedBrief.brief_path },
      target: { platform: "tiktok", duration_seconds: eff, tone: "energetic" },
      scenes: [{
        scene_id: "spdmat", sequence: 1, purpose: "beat", target_duration_seconds: eff, summary: "speed materialize check",
        source_clips: [{ manifest_file_index: 0, source_path: srcPath, in_seconds: w.in, out_seconds: w.out, role: "a_roll", speed: 2 }],
        overlays: [], captions: null, pacing: "fast",
      }],
      total_target_duration_seconds: eff,
    };
    const res = await materializeSceneClips({ projectId: GEN, storyboard: sb });
    const clipPath = res.scenes[0].clips[0].clip_path;
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", clipPath], { encoding: "utf8" });
    const dur = parseFloat((probe.stdout || "").trim());
    assert(Number.isFinite(dur) && Math.abs(dur - eff) < 0.3,
      `2x materialized clip should be ~${eff}s, got ${dur}`);
    console.log(`\n   speed: ${raw}s @2x materialized to ${dur.toFixed(2)}s (target ${eff}s)`);
  });

  // 7. fps path: cinematic 24fps plan → composition without data-fps warns
  //    vob/fps_mismatch; with data-fps="24" it is silent.
  await step("record video_type cinematic", () =>
    call("vob_record_intent_answer", { project_id: GEN, key: "video_type", value: "cinematic" }),
  );
  const cw1 = placeWindow({ keepSpans: null, len: 3, preferStart: D * 0.15, durationSeconds: D });
  const cw2 = placeWindow({ keepSpans: null, len: 4, preferStart: D * 0.55, durationSeconds: D });
  const cinSb = {
    schema_version: "1.0",
    project_id: GEN,
    generated_at: new Date().toISOString(),
    source: { manifest_path: boot.summary.manifest.path, brief_path: boot.savedBrief.brief_path },
    target: { platform: "cinematic", duration_seconds: 7, tone: "cinematic", fps: 24 },
    scenes: [
      generalScene({ sceneId: "c001", sequence: 1, purpose: "beat", win: cw1, targetSeconds: 3, sourcePath: srcPath }),
      generalScene({ sceneId: "c002", sequence: 2, purpose: "payoff", win: cw2, targetSeconds: 4, sourcePath: srcPath }),
    ],
    total_target_duration_seconds: 7,
    notes: "general walker — 24fps cinematic fixture.",
  };
  const savedCin = await step("save storyboard (cinematic, target.fps=24)", () =>
    call("vob_save_storyboard", { project_id: GEN, content: cinSb }),
  );
  assert(savedCin.plan_lint.error_count === 0, "cinematic storyboard reported plan-lint errors");
  await step("confirm storyboard", () => call("vob_confirm_storyboard", { project_id: GEN }));
  await step("transition PLAN→COMPOSE (pre-cut clips)", () =>
    call("vob_transition_phase", { project_id: GEN, to_phase: "COMPOSE" }),
  );
  await step("save composition (no data-fps ⇒ vob/fps_mismatch warning)", async () => {
    const saved = await call("vob_save_composition", {
      project_id: GEN,
      files: composition(cinSb, { width: 1920, height: 1080 }),
    });
    const rules = saved.qc.findings.map((f) => f.rule);
    assert(rules.includes("vob/fps_mismatch"),
      `expected vob/fps_mismatch warning, got ${JSON.stringify(rules)}`);
  });
  await step("save composition (data-fps=24 ⇒ clean of fps_mismatch)", async () => {
    const saved = await call("vob_save_composition", {
      project_id: GEN,
      files: composition(cinSb, { width: 1920, height: 1080, fps: 24 }),
    });
    const rules = saved.qc.findings.map((f) => f.rule);
    assert(!rules.includes("vob/fps_mismatch"),
      `fps_mismatch must not fire with data-fps=24, got ${JSON.stringify(rules)}`);
    if (saved.lint_status) console.log(`\n   lint_status: ${saved.lint_status}`);
  });

  const final = await call("vob_read_state_summary", { project_id: GEN });
  console.log(`\n=== general final phase: ${final.phase}   video_type: ${final.video_type.canonical} [${final.video_type.source}]`);
}

// ---------------------------------------------------------------------------
// v3 `longform` walker phase — the P2 executable spec: schema-1.2 segments[],
// manual render segmentation, per-segment compose/QC scoping + the
// {segment_id} cycle with REAL renders (preview + full per segment), the
// segment_renders registry surviving the RENDER→COMPOSE auto-archival,
// vob_assemble_video (fade boundary => duration-preserving re-encode path),
// the video_not_assembled gate, and PACKAGE chapters.

async function runLongform() {
  const LF = `${PROJECT_ID}-longform`;
  console.log(`=== v3 longform walker (segmented render + assembly) — project: ${LF}`);

  const boot = await bootstrapToPlan({
    projectId: LF,
    target: { format: "youtube", duration: "10 seconds" },
    intentAnswers: {
      target_platform: "youtube",
      target_duration: "10s",
      tone: "calm documentary",
      key_moments: "none in particular",
      music_vo: "neither",
      video_type: "long-form",
    },
    briefBody: `# Brief: ${LF}\n\n## Target\n- segmented long-form fixture, 2 acts × 5s\n\n## Design language\n- Typography: headline Hanken Grotesk; captions Inter\n- Palette: bg #000, text #FFF\n- Motion: medium\n`,
  });
  const D = boot.file0.duration_seconds;
  const srcPath = boot.file0.path || SOURCE;

  // 1. Schema-1.2 segmented storyboard: 2 acts × (2s+3s) = 10s total; act-1
  //    exits on a fade so assembly MUST take the re-encode (dip-to-black) path
  //    and still land drift-exact.
  const wins = {
    a1: placeWindow({ keepSpans: null, len: 2, preferStart: D * 0.05, durationSeconds: D }),
    a2: placeWindow({ keepSpans: null, len: 3, preferStart: D * 0.28, durationSeconds: D }),
    b1: placeWindow({ keepSpans: null, len: 2, preferStart: D * 0.55, durationSeconds: D }),
    b2: placeWindow({ keepSpans: null, len: 3, preferStart: D * 0.78, durationSeconds: D }),
  };
  const lfSb = {
    schema_version: "1.2",
    project_id: LF,
    generated_at: new Date().toISOString(),
    source: { manifest_path: boot.summary.manifest.path, brief_path: boot.savedBrief.brief_path },
    target: { platform: "youtube_long", duration_seconds: 10, tone: "calm documentary" },
    scenes: [
      generalScene({ sceneId: "a101", sequence: 1, purpose: "beat", win: wins.a1, targetSeconds: 2, sourcePath: srcPath }),
      generalScene({ sceneId: "a102", sequence: 2, purpose: "beat", win: wins.a2, targetSeconds: 3, sourcePath: srcPath }),
      generalScene({ sceneId: "b101", sequence: 3, purpose: "beat", win: wins.b1, targetSeconds: 2, sourcePath: srcPath }),
      generalScene({ sceneId: "b102", sequence: 4, purpose: "payoff", win: wins.b2, targetSeconds: 3, sourcePath: srcPath }),
    ],
    total_target_duration_seconds: 10,
    segments: [
      { segment_id: "act-1", title: "The Setup", sequence: 1, scene_ids: ["a101", "a102"], transition_out: "fade" },
      { segment_id: "act-2", title: "The Payoff", sequence: 2, scene_ids: ["b101", "b102"] },
    ],
    render_segmentation: "manual",
    notes: "Longform walker fixture — 2 render segments, fade boundary, chapters.",
  };
  const savedSb = await step("save storyboard (1.2 segments[], manual segmentation)", () =>
    call("vob_save_storyboard", { project_id: LF, content: lfSb }),
  );
  assert(savedSb.plan_lint.error_count === 0, "longform storyboard reported plan-lint errors");
  await step("confirm storyboard", () => call("vob_confirm_storyboard", { project_id: LF }));

  // 2. COMPOSE entry derives + stamps the render plan.
  const toCompose = await step("transition PLAN→COMPOSE (pre-cut + render plan)", () =>
    call("vob_transition_phase", { project_id: LF, to_phase: "COMPOSE" }),
  );
  assert(toCompose.clips && toCompose.clips.clip_count === 4, `expected 4 clips, got ${JSON.stringify(toCompose.clips)}`);
  {
    const rp = toCompose.phase_summary.render_plan;
    assert(rp && rp.mode === "segmented" && rp.segmentation === "manual" && rp.segment_count === 2,
      `render plan not stamped: ${JSON.stringify(rp)}`);
    assert(rp.segments[0].segment_id === "act-1" && rp.segments[0].rendered === false,
      `unexpected plan digest: ${JSON.stringify(rp.segments)}`);
    console.log(`   plan: ${rp.segments.map((s) => `${s.segment_id}(${s.target_duration_seconds}s/${s.video_count}v)`).join(" + ")}`);
  }

  const segView = (ids, total) => ({
    scenes: lfSb.scenes.filter((s) => ids.includes(s.scene_id)),
    total_target_duration_seconds: total,
  });
  const compAct1 = composition(segView(["a101", "a102"], 5), { width: 1920, height: 1080 });
  const compAct2 = composition(segView(["b101", "b102"], 5), { width: 1920, height: 1080 });

  // 3. Negative saves: segment_id required / validated; cross-segment refs warn.
  await step("save composition (missing segment_id rejected)", async () => {
    const err = await expectError("vob_save_composition", { project_id: LF, files: compAct1 }, /INVALID_ARGUMENTS/);
    assert(err.details && Array.isArray(err.details.valid_segment_ids)
      && err.details.valid_segment_ids.join(",") === "act-1,act-2",
      `expected valid_segment_ids, got ${JSON.stringify(err.details)}`);
  });
  await step("save composition (unknown segment_id rejected)", () =>
    expectError("vob_save_composition", { project_id: LF, files: compAct1, segment_id: "act-9" }, /INVALID_ARGUMENTS/),
  );
  await step("save composition (cross-segment ref warns)", async () => {
    const cross = {
      "index.html": compAct1["index.html"].replace(
        '<div id="hook-overlay"',
        '<video id="stray" class="full-bleed" src="./source/b101-0.mp4" muted data-start="0" data-duration="1" data-track-index="2" data-media-start="0" data-playback-start="0"></video>\n  <div id="hook-overlay"',
      ),
    };
    const saved = await call("vob_save_composition", { project_id: LF, files: cross, segment_id: "act-1" });
    assert(saved.qc.findings.some((f) => f.rule === "vob/cross_segment_clip_ref"),
      `expected vob/cross_segment_clip_ref warning, got ${JSON.stringify(saved.qc.findings.map((f) => f.rule))}`);
  });

  // 4. Assemble refuses while nothing is rendered.
  await step("assemble refused (nothing rendered yet)", async () => {
    const err = await expectError("vob_assemble_video", { project_id: LF }, /STATE_CONFLICT/);
    assert(err.details && Array.isArray(err.details.missing_segment_ids)
      && err.details.missing_segment_ids.join(",") === "act-1,act-2",
      `expected both segments missing, got ${JSON.stringify(err.details)}`);
  });

  // 5. Segment cycle helper: clean save → lint clean → PREVIEW (real draft
  //    render, drift scoped to the segment) → confirm → RENDER (real full
  //    render into segment_renders/) → confirm (registry mirror).
  async function renderSegment(segmentId, files, expectSeconds) {
    const saved = await step(`save composition (${segmentId})`, () =>
      call("vob_save_composition", { project_id: LF, files, segment_id: segmentId }),
    );
    assert(saved.segment_id === segmentId, `save result missing segment_id ${segmentId}`);
    if (saved.lint_status === "errors") throw new Error(`${segmentId} lint errors — see report`);
    await step(`transition COMPOSE→PREVIEW (${segmentId})`, () =>
      call("vob_transition_phase", { project_id: LF, to_phase: "PREVIEW" }),
    );
    const preview = await step(`render preview (${segmentId}, REAL)`, () =>
      call("vob_render_preview", { project_id: LF }),
    );
    assert(preview.verification && preview.verification.expected_duration_seconds === expectSeconds,
      `preview drift expectation should be the segment target ${expectSeconds}s, got ${JSON.stringify(preview.verification)}`);
    console.log(`   preview ${preview.render_duration_seconds.toFixed(1)}s wall, drift ${preview.verification.duration_drift_seconds}s`);
    await step(`confirm preview (${segmentId})`, () => call("vob_confirm_preview", { project_id: LF }));
    await step(`transition PREVIEW→RENDER (${segmentId})`, () =>
      call("vob_transition_phase", { project_id: LF, to_phase: "RENDER" }),
    );
    const render = await step(`render full (${segmentId}, REAL)`, () =>
      call("vob_render_full", { project_id: LF, quality: "standard" }),
    );
    assert(render.segment_id === segmentId, `render result missing segment_id`);
    assert(/segment_renders/.test(render.mp4_path), `partial must land in segment_renders/, got ${render.mp4_path}`);
    console.log(`   partial ${render.mp4_path.split("/").pop()} (${render.render_duration_seconds.toFixed(1)}s wall, drift ${render.verification.duration_drift_seconds}s)`);
    await step(`confirm render (${segmentId})`, () => call("vob_confirm_render", { project_id: LF }));
    const s = await call("vob_read_state_summary", { project_id: LF });
    const row = s.render_plan.segments.find((x) => x.segment_id === segmentId);
    assert(row && row.rendered === true && row.confirmed === true,
      `registry row not rendered+confirmed for ${segmentId}: ${JSON.stringify(row)}`);
    return render;
  }

  const render1 = await renderSegment("act-1", compAct1, 5);

  // 6. The cycle back-edge: RENDER→COMPOSE auto-archives renders/ — the
  //    partial in segment_renders/ MUST survive.
  await step("back-edge RENDER→COMPOSE (partial survives archival)", async () => {
    const r = await call("vob_transition_phase", { project_id: LF, to_phase: "COMPOSE" });
    assert(r.archived, "expected the back-edge to archive renders/");
    assert(fs.existsSync(render1.mp4_path), `act-1 partial vanished after archival: ${render1.mp4_path}`);
    const s = await call("vob_read_state_summary", { project_id: LF });
    const row = s.render_plan.segments.find((x) => x.segment_id === "act-1");
    assert(row && row.rendered === true, `act-1 registry entry lost after back-edge: ${JSON.stringify(row)}`);
  });

  await renderSegment("act-2", compAct2, 5);

  // 7. RENDER→PACKAGE blocks until assembled.
  await step("RENDER→PACKAGE blocked (video_not_assembled)", async () => {
    const err = await expectError("vob_transition_phase", { project_id: LF, to_phase: "PACKAGE" }, /STATE_CONFLICT/);
    const text = JSON.stringify(err.details || {}) + err.message;
    assert(/video_not_assembled/.test(text), `expected video_not_assembled, got ${text.slice(0, 300)}`);
  });

  // 8. Assemble: fade boundary forces the re-encode path; dip-to-black keeps
  //    the join drift-exact vs the 10s document total.
  const assembled = await step("assemble video (fade boundary, re-encode path)", () =>
    call("vob_assemble_video", { project_id: LF }),
  );
  assert(assembled.segment_ids.join(",") === "act-1,act-2", `wrong segment order: ${assembled.segment_ids}`);
  assert(assembled.concat_path === "filter", `fade boundary must take the filter path, got ${assembled.concat_path}`);
  assert(assembled.verification && Math.abs(assembled.verification.duration_drift_seconds) <= 0.5,
    `assembled drift exceeds 0.5s: ${JSON.stringify(assembled.verification)}`);
  console.log(`   final: ${assembled.final_path.split("/").pop()}   drift ${assembled.verification.duration_drift_seconds}s   path ${assembled.concat_path}`);
  {
    const s = await call("vob_read_state_summary", { project_id: LF });
    assert(s.assembly && s.assembly.is_current_render === true, `assembly not current render: ${JSON.stringify(s.assembly)}`);
    assert(s.render.mp4_path === assembled.final_path, "render slot must be the assembled final");
  }

  // 9. Confirm the assembled final → PACKAGE with chapters → ITERATE.
  await step("confirm render (assembled final)", () => call("vob_confirm_render", { project_id: LF }));
  await step("transition RENDER→PACKAGE", () =>
    call("vob_transition_phase", { project_id: LF, to_phase: "PACKAGE" }),
  );
  const pkg = await step("package output (chapters from narrative segments)", () =>
    call("vob_package_output", { project_id: LF }),
  );
  {
    const manifest = JSON.parse(fs.readFileSync(pkg.manifest_path, "utf8"));
    assert(Array.isArray(manifest.chapters) && manifest.chapters.length === 2,
      `expected 2 chapters, got ${JSON.stringify(manifest.chapters)}`);
    assert(manifest.chapters[0].start_seconds === 0 && manifest.chapters[0].youtube_stamp === "0:00"
      && manifest.chapters[1].start_seconds === 5 && manifest.chapters[1].youtube_stamp === "0:05",
      `chapter stamps wrong: ${JSON.stringify(manifest.chapters)}`);
    assert(manifest.video_type && manifest.video_type.canonical === "long-form",
      `manifest video_type wrong: ${JSON.stringify(manifest.video_type)}`);
    assert(manifest.assembly && manifest.assembly.segment_count === 2, "manifest assembly block missing");
    const readme = fs.readFileSync(pkg.readme_path, "utf8");
    assert(/## Chapters/.test(readme) && /0:00 The Setup/.test(readme) && /0:05 The Payoff/.test(readme),
      "README chapters section missing/wrong");
    console.log(`   chapters: ${manifest.chapters.map((c) => `${c.youtube_stamp} ${c.title}`).join(" | ")}`);
  }
  await step("transition PACKAGE→ITERATE", () =>
    call("vob_transition_phase", { project_id: LF, to_phase: "ITERATE" }),
  );
  await step("finalize iteration", () => call("vob_finalize_iteration", { project_id: LF }));

  const final = await call("vob_read_state_summary", { project_id: LF });
  console.log(`\n=== longform final phase: ${final.phase}   assembled drift: ${assembled.verification.duration_drift_seconds}s`);
}

// ---------------------------------------------------------------------------
// v3 `overlays` walker phase — the P3 executable spec: typed overlay objects
// (schema 1.2), the new plan-lint codes (bounds error; dwell/conflict/
// kinetic-no-speech/budget warnings), the QC element binding
// (vob/overlay_missing_element error; track-zero/unplanned warnings), and the
// storyboard.md rendering. No renders.

async function runOverlays() {
  const OV = `${PROJECT_ID}-overlays`;
  console.log(`=== v3 overlays walker (typed overlay layer) — project: ${OV}`);

  const boot = await bootstrapToPlan({
    projectId: OV,
    target: { format: "tiktok", duration: "10s" },
    intentAnswers: {
      target_platform: "tiktok",
      target_duration: "10s",
      tone: "energetic",
      key_moments: "none in particular",
      music_vo: "neither",
    },
    briefBody: `# Brief: ${OV}\n\n## Target\n- 10s tiktok with a planned overlay layer\n\n## Design language\n- Typography: headline Anton; captions Inter 900\n- Palette: bg #000, text #FFF, accent #FFD60A\n- Motion: fast-snap\n`,
  });
  const D = boot.file0.duration_seconds;
  const srcPath = boot.file0.path || SOURCE;
  let transcript = null;
  if (boot.inspect.speech_detected && boot.inspect.transcript_path && fs.existsSync(boot.inspect.transcript_path)) {
    try { transcript = JSON.parse(fs.readFileSync(boot.inspect.transcript_path, "utf8")); } catch { transcript = null; }
  }
  const speech = boot.inspect.speech_detected === true && Array.isArray(transcript) && transcript.length > 0;
  const windows = planWindows({ durationSeconds: D, transcript });

  const mkOverlayScene = (sceneId, sequence, purpose, win, targetSeconds, overlays, pacing) => ({
    scene_id: sceneId,
    sequence,
    purpose,
    target_duration_seconds: targetSeconds,
    summary: `${purpose} window at ${win ? win.in : "n/a"}s`,
    source_clips: win
      ? [{ manifest_file_index: 0, source_path: srcPath, in_seconds: win.in, out_seconds: win.out }]
      : [],
    overlays,
    captions: null,
    pacing,
  });

  const goodSb = {
    schema_version: "1.2",
    project_id: OV,
    generated_at: new Date().toISOString(),
    source: { manifest_path: boot.summary.manifest.path, brief_path: boot.savedBrief.brief_path },
    target: { platform: "tiktok", duration_seconds: 10, tone: "energetic" },
    scenes: [
      mkOverlayScene("o001", 1, "hook", { ...windows.hook, out: round3(windows.hook.in + 2) }, 2, [
        {
          id: "tc-1", type: "title_card", start_seconds: 0.2, end_seconds: 1.8, track: 2,
          content: { title: "WALKER OVERLAYS" },
          style: { font: "Anton", accent: "#FFD60A" },
          motion: { in: "slide_up", out: "fade" },
        },
      ], "fast"),
      mkOverlayScene("o002", 2, "beat", { ...windows.beat, out: round3(windows.beat.in + 5) }, 5, [
        {
          id: "lt-1", type: "lower_third", start_seconds: 0.5, end_seconds: 2.0, track: 2,
          content: { title: "Jane Walker", subtitle: "Fixture" },
          position: { anchor: "bottom-left", offset_px: [80, 320] },
        },
        // starts after lt-1 ends — same bottom-band group, NO overlap, no conflict
        { id: "kc-1", type: "kinetic_caption", start_seconds: 2.2, end_seconds: 4.7, track: 3 },
      ], "medium"),
      mkOverlayScene("o003", 3, "payoff", { ...windows.payoff, out: round3(windows.payoff.in + 3) }, 3, [
        { id: "pip-1", type: "pip", start_seconds: 0.4, end_seconds: 2.6, track: 1 },
        { id: "cta-1", type: "cta", start_seconds: 0.5, end_seconds: 2.2, track: 2, content: { text: "follow for part 2" } },
      ], "fast"),
    ],
    total_target_duration_seconds: 10,
    notes: "Overlay walker fixture — typed overlay layer, plan-lint-clean.",
  };

  // Caption binding (P5): two id-bearing captions on the beat scene — cap-1
  // (advisory) + cap-2 (exact: a binding contract). composition() stamps
  // data-vob-caption-id for each; QC binds them. SOURCE-time, inside the scene's
  // clip window so no PLAN_CAPTION_TIMING_DRIFT. Captions render on track 3 (like
  // the scene's kinetic_caption kc-1, master 4.2–6.7s) — keep both BEFORE 4.2s
  // master (scene-relative < 2.2s) so they don't overlap kc-1 on the same track
  // (hyperframes errors overlapping_clips_same_track). (cap-2 may warn
  // PLAN_CAPTION_EXACT_UNALIGNED on a non-aligned transcript — a warning, never
  // an error, so the plan-lint-clean assertions below still hold.)
  {
    const cw = goodSb.scenes[1].source_clips[0]; // in_seconds..out_seconds (SOURCE)
    goodSb.scenes[1].caption_segments = [
      { text: "bound caption", start_seconds: round3(cw.in_seconds + 0.3), end_seconds: round3(cw.in_seconds + 1.0), id: "cap-1" },
      { text: "exact caption", start_seconds: round3(cw.in_seconds + 1.1), end_seconds: round3(cw.in_seconds + 1.9), id: "cap-2", exact: true },
    ];
  }

  // 1. Schema negatives.
  await step("save storyboard (typed overlay under 1.0 rejected)", async () => {
    const old = JSON.parse(JSON.stringify(goodSb));
    old.schema_version = "1.0";
    const err = await expectError("vob_save_storyboard", { project_id: OV, content: old }, /INVALID_ARGUMENTS/);
    assert((err.details.schema_errors || []).some((m) => /typed overlay object.*1\.2/.test(String(m))),
      `expected the 1.2 gating error, got ${JSON.stringify(err.details.schema_errors)}`);
  });
  await step("save storyboard (unknown overlay type rejected)", async () => {
    const bad = JSON.parse(JSON.stringify(goodSb));
    bad.scenes[0].overlays[0].type = "hologram";
    const err = await expectError("vob_save_storyboard", { project_id: OV, content: bad }, /INVALID_ARGUMENTS/);
    assert((err.details.schema_errors || []).some((m) => /type must be one of/.test(String(m))),
      `expected the vocabulary error, got ${JSON.stringify(err.details.schema_errors)}`);
  });
  await step("save storyboard (duplicate overlay id rejected)", async () => {
    const bad = JSON.parse(JSON.stringify(goodSb));
    bad.scenes[2].overlays[1].id = "tc-1";
    const err = await expectError("vob_save_storyboard", { project_id: OV, content: bad }, /INVALID_ARGUMENTS/);
    assert((err.details.schema_errors || []).some((m) => /overlay id "tc-1".*duplicates/.test(String(m))),
      `expected the duplicate-id error, got ${JSON.stringify(err.details.schema_errors)}`);
  });

  // 2. Plan-lint negative: out-of-bounds timing is an ERROR (rejects the save).
  await step("save storyboard (overlay out of bounds rejected)", async () => {
    const bad = JSON.parse(JSON.stringify(goodSb));
    bad.scenes[0].overlays[0].end_seconds = 4.0; // scene is 2s
    const err = await expectError("vob_save_storyboard", { project_id: OV, content: bad }, /INVALID_ARGUMENTS/);
    assert((err.details.plan_errors || []).some((f) => f && f.code === "PLAN_OVERLAY_OUT_OF_BOUNDS"),
      `expected PLAN_OVERLAY_OUT_OF_BOUNDS, got ${JSON.stringify(err.details.plan_errors)}`);
  });

  // 3. Warnings fixture: dwell, conflict, kinetic-without-speech, PiP budget.
  await step("save storyboard (overlay warnings fixture)", async () => {
    const warny = JSON.parse(JSON.stringify(goodSb));
    warny.scenes[0].overlays[0].end_seconds = 0.5; // 0.3s title_card -> dwell
    warny.scenes[1].overlays[1] = { // overlap lt-1 in the bottom band -> conflict
      id: "cb-1", type: "caption_block", start_seconds: 1.0, end_seconds: 3.0, track: 3,
    };
    warny.scenes.push(mkOverlayScene("o004", 4, "beat", null, 2, [
      { id: "kc-9", type: "kinetic_caption", start_seconds: 0.2, end_seconds: 1.8, track: 3 },
    ], "medium"));
    warny.scenes.push(mkOverlayScene("o005", 5, "beat", { ...windows.payoff, out: round3(windows.payoff.in + 2) }, 2, [
      { id: "p1", type: "pip", start_seconds: 0.1, end_seconds: 1.9, track: 1 },
      { id: "p2", type: "pip", start_seconds: 0.1, end_seconds: 1.9, track: 2 },
      { id: "p3", type: "pip", start_seconds: 0.1, end_seconds: 1.9, track: 4 },
    ], "medium"));
    warny.total_target_duration_seconds = 14;
    const saved = await call("vob_save_storyboard", { project_id: OV, content: warny });
    const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
    for (const code of ["PLAN_OVERLAY_DWELL_TOO_SHORT", "PLAN_OVERLAY_CONFLICT", "PLAN_VIDEO_BUDGET_EXCEEDED"]) {
      assert(codes.includes(code), `expected ${code}, got ${JSON.stringify(codes)}`);
    }
    if (speech) {
      assert(codes.includes("PLAN_KINETIC_CAPTION_NO_SPEECH"),
        `expected PLAN_KINETIC_CAPTION_NO_SPEECH on the clip-less scene, got ${JSON.stringify(codes)}`);
    }
    console.log(`\n   overlay warnings: ${codes.filter((c) => /OVERLAY|VIDEO_BUDGET|KINETIC/.test(c)).join(", ")}`);
  });

  // 4. Good save: none of the overlay warnings fire; markdown renders the layer.
  const savedGood = await step("save storyboard (typed overlays, plan-lint-clean)", () =>
    call("vob_save_storyboard", { project_id: OV, content: goodSb }),
  );
  {
    assert(savedGood.plan_lint.error_count === 0, "good overlay storyboard reported plan errors");
    const codes = (savedGood.plan_lint.warnings || []).map((w) => w.code);
    for (const code of ["PLAN_OVERLAY_DWELL_TOO_SHORT", "PLAN_OVERLAY_CONFLICT", "PLAN_OVERLAY_OUT_OF_BOUNDS", "PLAN_VIDEO_BUDGET_EXCEEDED", "PLAN_KINETIC_CAPTION_NO_SPEECH"]) {
      assert(!codes.includes(code), `good doc must not warn ${code}: ${JSON.stringify(codes)}`);
    }
    const md = fs.readFileSync(savedGood.markdown_path, "utf8");
    assert(/\*\*\[title_card\]\*\* `tc-1`/.test(md) && /\*\*\[pip\]\*\* `pip-1`/.test(md),
      "storyboard.md missing typed overlay rendering");
  }
  await step("confirm storyboard", () => call("vob_confirm_storyboard", { project_id: OV }));
  await step("transition PLAN→COMPOSE", () =>
    call("vob_transition_phase", { project_id: OV, to_phase: "COMPOSE" }),
  );

  // 5. QC binding: a planned overlay with no implementing element REJECTS.
  const goodComp = composition(goodSb);
  await step("save composition (missing overlay element rejected)", async () => {
    const broken = { "index.html": goodComp["index.html"].replace(/^.*data-vob-overlay-id="lt-1".*$\n/m, "") };
    assert(!/data-vob-overlay-id="lt-1"/.test(broken["index.html"]), "fixture surgery failed — lt-1 still present");
    const err = await expectError("vob_save_composition", { project_id: OV, files: broken }, /INVALID_ARGUMENTS/);
    const rules = (err.details.qc_findings || []).map((f) => f.rule);
    assert(rules.includes("vob/overlay_missing_element"), `expected vob/overlay_missing_element, got ${JSON.stringify(rules)}`);
  });

  // 6. QC warnings: spine-track overlay + composer-invented overlay id.
  await step("save composition (track-zero + unplanned overlay warn)", async () => {
    const warny = {
      "index.html": goodComp["index.html"]
        .replace('data-vob-overlay-id="tc-1" data-start="0.2" data-duration="1.6" data-track-index="2"',
          'data-vob-overlay-id="tc-1" data-start="0.2" data-duration="1.6" data-track-index="0"')
        .replace(
          '<div id="hook-overlay"',
          '<div id="ghost" class="clip caption" data-vob-overlay-id="ghost-1" data-start="0.5" data-duration="1" data-track-index="2"><span>ghost</span></div>\n  <div id="hook-overlay"',
        ),
    };
    const saved = await call("vob_save_composition", { project_id: OV, files: warny });
    const rules = saved.qc.findings.map((f) => f.rule);
    assert(rules.includes("vob/overlay_track_zero"), `expected vob/overlay_track_zero, got ${JSON.stringify(rules)}`);
    assert(rules.includes("vob/unplanned_overlay_element"), `expected vob/unplanned_overlay_element, got ${JSON.stringify(rules)}`);
  });

  // 6b. Caption binding (P5): an EXACT caption with no element REJECTS; an
  // advisory (non-exact) id-bearing caption with no element WARNS (save stands).
  await step("save composition (exact caption missing element rejected)", async () => {
    const broken = { "index.html": goodComp["index.html"].replace(/^.*data-vob-caption-id="cap-2".*$\n/m, "") };
    assert(!/data-vob-caption-id="cap-2"/.test(broken["index.html"]), "fixture surgery failed — cap-2 still present");
    const err = await expectError("vob_save_composition", { project_id: OV, files: broken }, /INVALID_ARGUMENTS/);
    const rules = (err.details.qc_findings || []).map((f) => f.rule);
    assert(rules.includes("vob/caption_missing_element"), `expected vob/caption_missing_element, got ${JSON.stringify(rules)}`);
  });
  await step("save composition (advisory caption unbound warns, save stands)", async () => {
    const warny = { "index.html": goodComp["index.html"].replace(/^.*data-vob-caption-id="cap-1".*$\n/m, "") };
    assert(!/data-vob-caption-id="cap-1"/.test(warny["index.html"]), "fixture surgery failed — cap-1 still present");
    const saved = await call("vob_save_composition", { project_id: OV, files: warny });
    const rules = saved.qc.findings.map((f) => f.rule);
    assert(rules.includes("vob/caption_unbound"), `expected vob/caption_unbound, got ${JSON.stringify(rules)}`);
    assert(!rules.includes("vob/caption_missing_element"), `advisory caption must NOT error, got ${JSON.stringify(rules)}`);
  });

  // 7. Clean save: every planned overlay AND caption bound, no binding findings.
  const savedComp = await step("save composition (overlay + caption layer, QC-clean)", () =>
    call("vob_save_composition", { project_id: OV, files: goodComp }),
  );
  {
    const rules = savedComp.qc.findings.map((f) => f.rule);
    assert(!rules.some((r) => /overlay/.test(r)), `clean save must carry no overlay findings, got ${JSON.stringify(rules)}`);
    assert(!rules.some((r) => /^vob\/caption_(missing_element|unbound|element_untimed)$/.test(r) || r === "vob/unplanned_caption_element"),
      `clean save must carry no caption-binding findings, got ${JSON.stringify(rules)}`);
    console.log(`   lint_status: ${savedComp.lint_status || "(infra fallback)"}   qc warnings: ${savedComp.qc.warning_count}`);
    if (savedComp.lint_status === "errors") throw new Error("overlay composition lint failed");
  }

  const final = await call("vob_read_state_summary", { project_id: OV });
  console.log(`\n=== overlays final phase: ${final.phase}`);
}

// ---------------------------------------------------------------------------
// v3 `gaps` walker phase — the P4 executable spec: richer planned b-roll
// (render_mode/motion), the gap shopping-list form (source:"gap"),
// plan/broll_gaps.json emission + the PLAN_BROLL_GAP_UNFILLED warning, the
// PLAN→INGEST back-edge loop (re-ingest → INSPECT → INTENT → PLAN), and gap
// auto-resolution on the next save. No renders.

async function runGaps() {
  const GP = `${PROJECT_ID}-gaps`;
  console.log(`=== v3 gaps walker (planned b-roll + shopping list) — project: ${GP}`);

  const boot = await bootstrapToPlan({
    projectId: GP,
    target: { format: "tiktok", duration: "8s" },
    intentAnswers: {
      target_platform: "tiktok",
      target_duration: "8s",
      tone: "energetic",
      key_moments: "none in particular",
      music_vo: "neither",
    },
    briefBody: `# Brief: ${GP}\n\n## Target\n- 8s tiktok; b-roll plan with one coverage gap\n\n## Design language\n- Typography: headline Anton; captions Inter 900\n- Palette: bg #000, text #FFF\n- Motion: fast-snap\n`,
  });
  const D = boot.file0.duration_seconds;
  const srcPath = boot.file0.path || SOURCE;
  let transcript = null;
  if (boot.inspect.speech_detected && boot.inspect.transcript_path && fs.existsSync(boot.inspect.transcript_path)) {
    try { transcript = JSON.parse(fs.readFileSync(boot.inspect.transcript_path, "utf8")); } catch { transcript = null; }
  }
  const windows = planWindows({ durationSeconds: D, transcript });
  const brollWin = placeWindow({ keepSpans: null, len: 2, preferStart: D * 0.85, durationSeconds: D });

  const gapSb = {
    schema_version: "1.2",
    project_id: GP,
    generated_at: new Date().toISOString(),
    source: { manifest_path: boot.summary.manifest.path, brief_path: boot.savedBrief.brief_path },
    target: { platform: "tiktok", duration_seconds: 8, tone: "energetic" },
    scenes: [
      {
        scene_id: "g001", sequence: 1, purpose: "hook", target_duration_seconds: 2,
        summary: `Cold open at ${windows.hook.in}s.`,
        source_clips: [{ manifest_file_index: 0, source_path: srcPath, in_seconds: windows.hook.in, out_seconds: windows.hook.out }],
        overlays: [], captions: null, pacing: "fast",
      },
      {
        scene_id: "g002", sequence: 2, purpose: "beat", target_duration_seconds: 3,
        summary: `Core beat at ${windows.beat.in}s with a planned PiP cutaway.`,
        source_clips: [
          { manifest_file_index: 0, source_path: srcPath, in_seconds: windows.beat.in, out_seconds: windows.beat.out, role: "a_roll" },
          { manifest_file_index: 0, source_path: srcPath, in_seconds: brollWin.in, out_seconds: brollWin.out, role: "b_roll" },
        ],
        overlays: [], captions: null, pacing: "medium",
      },
      {
        scene_id: "g003", sequence: 3, purpose: "payoff", target_duration_seconds: 3,
        summary: `Payoff hold at ${windows.payoff.in}s — wants a close-up we don't have.`,
        source_clips: [{ manifest_file_index: 0, source_path: srcPath, in_seconds: windows.payoff.in, out_seconds: windows.payoff.out }],
        overlays: [], captions: null, pacing: "slow",
      },
    ],
    broll_placements: [
      {
        clip: { scene_id: "g002", clip_index: 1 },
        render_mode: "pip",
        motion: "ken_burns",
        narration_span: { start_seconds: round3(windows.beat.in + 0.3), end_seconds: round3(windows.beat.in + 2.3) },
        reason: "inset the supporting shot while the beat lands",
      },
      {
        source: "gap",
        description: "close-up of hands typing on the keyboard",
        desired_duration_seconds: 2.5,
        scene_ref: "g003",
        reason: "cover the payoff narration with a concrete visual",
      },
    ],
    total_target_duration_seconds: 8,
    notes: "Gaps walker fixture — one concrete PiP placement, one coverage gap.",
  };

  // 1. Schema negatives for the new placement fields.
  await step("save storyboard (gap form under 1.1 rejected)", async () => {
    const old = JSON.parse(JSON.stringify(gapSb));
    old.schema_version = "1.1";
    const err = await expectError("vob_save_storyboard", { project_id: GP, content: old }, /INVALID_ARGUMENTS/);
    const msgs = (err.details.schema_errors || []).map(String);
    assert(msgs.some((m) => /source:"gap".*1\.2/.test(m)) && msgs.some((m) => /render_mode requires/.test(m)),
      `expected 1.2 gating errors for gap + render_mode, got ${JSON.stringify(msgs)}`);
  });
  await step("save storyboard (clip + gap on one placement rejected)", async () => {
    const bad = JSON.parse(JSON.stringify(gapSb));
    bad.broll_placements[1].clip = { scene_id: "g002", clip_index: 1 };
    const err = await expectError("vob_save_storyboard", { project_id: GP, content: bad }, /INVALID_ARGUMENTS/);
    assert((err.details.schema_errors || []).some((m) => /concrete or a gap, never both/.test(String(m))),
      `expected the mutual-exclusion error, got ${JSON.stringify(err.details.schema_errors)}`);
  });
  await step("save storyboard (gap with unknown scene_ref rejected)", async () => {
    const bad = JSON.parse(JSON.stringify(gapSb));
    bad.broll_placements[1].scene_ref = "g999";
    const err = await expectError("vob_save_storyboard", { project_id: GP, content: bad }, /INVALID_ARGUMENTS/);
    assert((err.details.schema_errors || []).some((m) => /scene_ref "g999"/.test(String(m))),
      `expected the scene_ref error, got ${JSON.stringify(err.details.schema_errors)}`);
  });
  await step("save storyboard (bad render_mode rejected)", async () => {
    const bad = JSON.parse(JSON.stringify(gapSb));
    bad.broll_placements[0].render_mode = "split_screen";
    const err = await expectError("vob_save_storyboard", { project_id: GP, content: bad }, /INVALID_ARGUMENTS/);
    assert((err.details.schema_errors || []).some((m) => /render_mode must be one of/.test(String(m))),
      `expected the render_mode enum error, got ${JSON.stringify(err.details.schema_errors)}`);
  });

  // 2. Good save: the gap rides as an artifact + a warning, never a blocker.
  const savedGap = await step("save storyboard (1 concrete PiP + 1 gap)", () =>
    call("vob_save_storyboard", { project_id: GP, content: gapSb }),
  );
  {
    assert(savedGap.plan_lint.error_count === 0, "gap storyboard reported plan errors");
    const codes = (savedGap.plan_lint.warnings || []).map((w) => w.code);
    assert(codes.includes("PLAN_BROLL_GAP_UNFILLED"), `expected PLAN_BROLL_GAP_UNFILLED, got ${JSON.stringify(codes)}`);
    assert(savedGap.broll_gap_count === 1 && savedGap.broll_gaps_path,
      `expected broll_gap_count 1 + path, got ${JSON.stringify({ c: savedGap.broll_gap_count, p: savedGap.broll_gaps_path })}`);
    const gapsDoc = JSON.parse(fs.readFileSync(savedGap.broll_gaps_path, "utf8"));
    assert(gapsDoc.gap_count === 1 && gapsDoc.gaps[0].id === "gap-2" && gapsDoc.gaps[0].scene_ref === "g003"
      && gapsDoc.gaps[0].desired_duration_seconds === 2.5,
      `broll_gaps.json wrong: ${JSON.stringify(gapsDoc)}`);
    const md = fs.readFileSync(savedGap.markdown_path, "utf8");
    assert(/\*\*GAP\*\* for scene g003/.test(md) && /\[PIP\]/.test(md) && /~ken_burns/.test(md),
      "storyboard.md missing gap/render_mode/motion rendering");
    const summary = await call("vob_read_state_summary", { project_id: GP });
    assert(summary.storyboard.broll_gap_count === 1, `summary broll_gap_count wrong: ${JSON.stringify(summary.storyboard)}`);
    console.log(`\n   gap recorded: ${gapsDoc.gaps[0].description} (~${gapsDoc.gaps[0].desired_duration_seconds}s for ${gapsDoc.gaps[0].scene_ref})`);
  }

  // 3. The resolution loop: PLAN→INGEST back-edge, re-ingest (caches make the
  //    old file cheap), re-walk INSPECT→INTENT→PLAN with answers intact.
  await step("back-edge PLAN→INGEST (gap resolution loop)", () =>
    call("vob_transition_phase", { project_id: GP, to_phase: "INGEST" }),
  );
  await step("re-ingest (extended drop)", () =>
    call("vob_ingest_file", { project_id: GP, source_path: SOURCE }),
  );
  await step("transition INGEST→INSPECT", () =>
    call("vob_transition_phase", { project_id: GP, to_phase: "INSPECT" }),
  );
  const inspect2 = await step("re-inspect (cached detection)", () =>
    call("vob_inspect_source", { project_id: GP }),
  );
  if (inspect2.segment_count > 0) {
    const segmentsDoc = JSON.parse(fs.readFileSync(inspect2.segments_path, "utf8"));
    await step("save classification (canned)", () =>
      call("vob_save_classification", { project_id: GP, ...cannedClassification(segmentsDoc) }),
    );
  }
  await step("acknowledge inspect", () => call("vob_acknowledge_inspect", { project_id: GP }));
  await step("transition INSPECT→INTENT", () =>
    call("vob_transition_phase", { project_id: GP, to_phase: "INTENT" }),
  );
  await step("transition INTENT→PLAN (answers persisted)", () =>
    call("vob_transition_phase", { project_id: GP, to_phase: "PLAN" }),
  );

  // 4. The re-derived plan fills the gap (the new coverage exists) — the gap
  //    list empties and the warning disappears.
  await step("re-save storyboard (gap resolved)", async () => {
    const resolved = JSON.parse(JSON.stringify(gapSb));
    resolved.broll_placements = [resolved.broll_placements[0]]; // gap filled by real coverage
    const saved = await call("vob_save_storyboard", { project_id: GP, content: resolved });
    const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
    assert(!codes.includes("PLAN_BROLL_GAP_UNFILLED"), `gap warning must clear, got ${JSON.stringify(codes)}`);
    assert(saved.broll_gap_count === 0, `expected broll_gap_count 0, got ${saved.broll_gap_count}`);
    const gapsDoc = JSON.parse(fs.readFileSync(savedGap.broll_gaps_path, "utf8"));
    assert(gapsDoc.gap_count === 0 && gapsDoc.gaps.length === 0, `broll_gaps.json must empty on resolve: ${JSON.stringify(gapsDoc)}`);
  });

  const final = await call("vob_read_state_summary", { project_id: GP });
  console.log(`\n=== gaps final phase: ${final.phase}   broll_gap_count: ${final.storyboard.broll_gap_count}`);
}

// Synthesize a single deterministic still via ffmpeg lavfi (no source video).
function synthStill(filterSrc, outPath) {
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", filterSrc, "-frames:v", "1", "-y", outPath],
    { stdio: "ignore" },
  );
}

// Auto-QC of stills (PREVIEW QC-C) — exercises the pure classifier, the real
// ffprobe signalstats path, and vob_qc_stills end-to-end over three synthetic
// stills (black / blown / clean gradient). Fully deterministic; no render, no
// source video, no hyperframes — just ffmpeg + ffprobe.
async function runStillsQc() {
  const SQ = `${PROJECT_ID}-stillsqc`;
  console.log(`=== auto-QC of stills walker (QC-C luma) — project: ${SQ}`);

  // 1. Pure classifier regression (no I/O).
  await step("classifier: black/blown/flat/clean/unprobed", async () => {
    const cases = [
      [{ probed: true, ymin: 0, yavg: 0, ymax: 0 }, "qc/still_black"],
      [{ probed: true, ymin: 255, yavg: 255, ymax: 255 }, "qc/still_blown_out"],
      [{ probed: true, ymin: 40, yavg: 48, ymax: 55 }, "qc/still_flat"],
      [{ probed: true, ymin: 32, yavg: 150, ymax: 224 }, null],
      [{ probed: false, error: "x" }, null],
    ];
    for (const [luma, want] of cases) {
      const got = classifyStillLuma(luma);
      const code = got ? got.code : null;
      assert(code === want, `classify ${JSON.stringify(luma)} -> ${code}, expected ${want}`);
    }
  });

  // 2. Bare project + three synthetic stills in its snapshots dir.
  try {
    await call("vob_init_project", { project_id: SQ, target: { format: "tiktok", duration: "8s" } });
  } catch (e) { /* idempotent: already created on a prior run */ }
  const dir = snapshotsDir(SQ);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  synthStill("color=c=black:s=320x180", path.join(dir, "00-black.png"));
  synthStill("color=c=white:s=320x180", path.join(dir, "01-white.png"));
  synthStill("gradients=s=320x180:c0=0x202020:c1=0xE0E0E0", path.join(dir, "02-grad.png"));

  // 3. Real ffprobe signalstats path (locks the parser to ffprobe output).
  await step("signalstatsLuma: black ymax=0, white ymin=255", async () => {
    const black = signalstatsLuma(path.join(dir, "00-black.png"));
    const white = signalstatsLuma(path.join(dir, "01-white.png"));
    assert(black.probed && black.ymax === 0, `black ymax expected 0, got ${JSON.stringify(black)}`);
    assert(white.probed && white.ymin === 255, `white ymin expected 255, got ${JSON.stringify(white)}`);
  });

  // 4. The tool end-to-end via executeTool (schema + envelope, not bare handler).
  const res = await step("vob_qc_stills over 3 synth stills", () =>
    call("vob_qc_stills", { project_id: SQ, timecodes: [0.5, 1.5, 2.5] }),
  );
  assert(res.count === 3, `expected 3 stills, got ${res.count}`);
  assert(res.frames_probed === 3, `expected 3 probed, got ${res.frames_probed}`);
  assert(res.glaring_count === 2, `expected 2 glaring (black+blown), got ${res.glaring_count}`);
  assert(res.taste_count === 0, `expected 0 taste (gradient is clean), got ${res.taste_count}`);
  const codes = res.findings.map((f) => f.code);
  assert(codes.includes("qc/still_black"), `expected qc/still_black, got [${codes.join(",")}]`);
  assert(codes.includes("qc/still_blown_out"), `expected qc/still_blown_out, got [${codes.join(",")}]`);
  const black = res.findings.find((f) => f.code === "qc/still_black");
  assert(
    black.frame_index === 0 && black.timecode_seconds === 0.5,
    `black should be frame 0 @ t=0.5, got idx=${black.frame_index} t=${black.timecode_seconds}`,
  );
  assert(fs.existsSync(path.join(dir, "stills-qc.json")), "stills-qc.json report not written");

  // 5. Negative: empty snapshots dir -> NOT_FOUND (run snapshot first).
  const SQ2 = `${SQ}-empty`;
  try {
    await call("vob_init_project", { project_id: SQ2, target: { format: "tiktok", duration: "8s" } });
  } catch (e) { /* idempotent */ }
  fs.rmSync(snapshotsDir(SQ2), { recursive: true, force: true });
  await step("vob_qc_stills with no stills -> NOT_FOUND", () =>
    expectError("vob_qc_stills", { project_id: SQ2 }, /NOT_FOUND/),
  );

  console.log("=== stillsqc walker OK");
}

// ---------------------------------------------------------------------------
// v3.3 `captions` walker phase — the Caption System v2 executable spec: the
// vendored caption kit injected into compose/captions/, the hyperframes-inspect
// layout/legibility QC fold-in (lint-report report_version 3 + inspect{} block,
// the vob/caption_overflow warning), all three caption animations + emphasis +
// exact/id binding + style_ref, and the word-level alignment fallback.
//
// Cost control: the in-session inspect render (a browser pass per captioned
// save) is gated to VOB_WALKER_LAYOUT_QC=1; with it off the fold-in still stamps
// the inspect{} block (skipped:disabled), proving the wiring. The overflow
// FIRING is proven cheaply every run on a tiny synthetic composition (real
// `hyperframes inspect`, no <video>).

async function runCaptions() {
  const CAP = `${PROJECT_ID}-captions`;
  console.log(`=== v3.3 captions walker (caption kit + layout QC) — project: ${CAP}`);

  const os = require("os");
  const { runInspect } = require("../mcp/lib/hyperframes-runner.js");
  const { parseInspectReport, mapInspectIssues, shouldRunLayoutQc, layoutQcMode } = require("../mcp/lib/layout-qc.js");

  const HEAVY = process.env.VOB_WALKER_LAYOUT_QC === "1";
  const prevLayoutQc = process.env.VOB_LAYOUT_QC;
  process.env.VOB_LAYOUT_QC = HEAVY ? "always" : "off";

  try {

  const boot = await bootstrapToPlan({
    projectId: CAP,
    target: { format: "tiktok", duration: "8s" },
    intentAnswers: {
      target_platform: "tiktok",
      target_duration: "8s",
      tone: "energetic",
      key_moments: "none in particular",
      music_vo: "neither",
    },
    briefBody: `# Brief: ${CAP}\n\n## Target\n- 8s tiktok with a kinetic caption layer\n\n## Design language\n- Typography: headline Anton; captions Hanken Grotesk\n- Palette: bg #000, text #FFF, accent #FFD60A\n- Caption style: bold-pop\n- Motion: fast-snap\n`,
  });
  const D = boot.file0.duration_seconds;
  const srcPath = boot.file0.path || SOURCE;
  let transcript = null;
  if (boot.inspect.speech_detected && boot.inspect.transcript_path && fs.existsSync(boot.inspect.transcript_path)) {
    try { transcript = JSON.parse(fs.readFileSync(boot.inspect.transcript_path, "utf8")); } catch { transcript = null; }
  }
  const aligned = boot.inspect.transcript_aligned === true;
  const windows = planWindows({ durationSeconds: D, transcript });
  const bi = windows.beat.in; // beat clip window [bi, bi+3] (SOURCE-time)

  const goodSb = {
    schema_version: "1.0", // caption fields are NON-version-gated (valid on 1.0)
    project_id: CAP,
    generated_at: new Date().toISOString(),
    source: { manifest_path: boot.summary.manifest.path, brief_path: boot.savedBrief.brief_path },
    target: {
      platform: "tiktok", duration_seconds: 8, tone: "energetic", fps: 30,
      design: {
        palette: { bg: "#000000", text: "#FFFFFF", accent: "#FFD60A" },
        typography: { headline: "Anton", caption: "Hanken Grotesk" },
        caption_style: "bold-pop", motion: "fast-snap", grade: "high-contrast",
      },
    },
    scenes: [
      {
        scene_id: "c001", sequence: 1, purpose: "hook", target_duration_seconds: 2,
        summary: "Cold open on the most kinetic frame.",
        source_clips: [{ manifest_file_index: 0, source_path: srcPath, in_seconds: windows.hook.in, out_seconds: windows.hook.out }],
        overlays: [], captions: null, pacing: "fast",
      },
      {
        scene_id: "c002", sequence: 2, purpose: "beat", target_duration_seconds: 3,
        summary: "Core beat carrying the kinetic captions.",
        source_clips: [{ manifest_file_index: 0, source_path: srcPath, in_seconds: bi, out_seconds: round3(bi + 3) }],
        overlays: [], captions: "kinetic caption pass", pacing: "medium",
        // SOURCE-time, all inside [bi, bi+3]; non-overlapping. Exercises all 3
        // animations + emphasis + an exact/id binding + style_ref.
        caption_segments: [
          {
            id: "cx-1", exact: true, text: "watch this part",
            start_seconds: round3(bi + 0.3), end_seconds: round3(bi + 1.0),
            animation: "pop", style_ref: "bold-pop", emphasis: true, emphasis_words: ["watch"],
            position: { anchor: "bottom-center", offset_px: [0, -120] },
          },
          {
            text: "one word at a time",
            start_seconds: round3(bi + 1.1), end_seconds: round3(bi + 1.9),
            animation: "word-by-word", style_ref: "bold-pop", emphasis_words: ["word"],
          },
          {
            text: "read along now",
            start_seconds: round3(bi + 2.0), end_seconds: round3(bi + 2.8),
            animation: "karaoke", style_ref: "bold-pop",
          },
        ],
      },
      {
        scene_id: "c003", sequence: 3, purpose: "payoff", target_duration_seconds: 3,
        summary: "Payoff hold on the resolving frame.",
        source_clips: [{ manifest_file_index: 0, source_path: srcPath, in_seconds: windows.payoff.in, out_seconds: windows.payoff.out }],
        overlays: [], captions: null, pacing: "slow",
      },
    ],
    total_target_duration_seconds: 8,
    notes: "Caption walker fixture — all three animations + exact/id binding + style_ref.",
  };

  // 1. Good save: plan-lint ERROR-clean (every caption code is a warning). The
  // word-level alignment warnings ride along ONLY on a non-forced-aligned
  // transcript — the keystone alignment guard (regression).
  const saved = await step("save storyboard (caption layer, plan-lint clean)", () =>
    call("vob_save_storyboard", { project_id: CAP, content: goodSb }),
  );
  {
    assert(saved.plan_lint.error_count === 0, `caption storyboard reported plan errors: ${JSON.stringify(saved.plan_lint)}`);
    const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
    if (aligned) {
      for (const c of ["PLAN_CAPTION_KARAOKE_UNALIGNED", "PLAN_CAPTION_EXACT_UNALIGNED"]) {
        assert(!codes.includes(c), `aligned transcript must not warn ${c}: ${JSON.stringify(codes)}`);
      }
    } else {
      assert(codes.filter((c) => c === "PLAN_CAPTION_KARAOKE_UNALIGNED").length >= 2,
        `expected 2x PLAN_CAPTION_KARAOKE_UNALIGNED (word-by-word + karaoke) on an unaligned transcript, got ${JSON.stringify(codes)}`);
      assert(codes.includes("PLAN_CAPTION_EXACT_UNALIGNED"),
        `expected PLAN_CAPTION_EXACT_UNALIGNED on the exact:true segment, got ${JSON.stringify(codes)}`);
    }
    console.log(`   transcript_aligned: ${aligned}   caption warnings: ${codes.filter((c) => /CAPTION/.test(c)).join(", ") || "(none)"}`);
  }

  // 1b. Alignment guard, BOTH branches, host-independent. The live branch above
  // only exercises whichever alignment THIS host's ASR produces (here: false);
  // drive the plan linter directly with a forced transcript_aligned flag so the
  // aligned (no-warning) branch is provably covered on every machine.
  await step("plan-lint alignment guard (both branches, synthetic)", async () => {
    const { validateStoryboardContent } = require("../mcp/lib/storyboard-schema.js");
    const onAligned = validateStoryboardContent(goodSb, { inspect: { transcript_aligned: true } });
    assert(onAligned.ok, `forced-aligned plan must be content-valid: ${JSON.stringify(onAligned.errors)}`);
    const codesT = (onAligned.warnings || []).map((w) => w.code);
    for (const c of ["PLAN_CAPTION_KARAOKE_UNALIGNED", "PLAN_CAPTION_EXACT_UNALIGNED"]) {
      assert(!codesT.includes(c), `forced-aligned plan must NOT warn ${c}: ${JSON.stringify(codesT)}`);
    }
    const onUnaligned = validateStoryboardContent(goodSb, { inspect: { transcript_aligned: false } });
    const codesF = (onUnaligned.warnings || []).map((w) => w.code);
    assert(codesF.filter((c) => c === "PLAN_CAPTION_KARAOKE_UNALIGNED").length >= 2 && codesF.includes("PLAN_CAPTION_EXACT_UNALIGNED"),
      `forced-unaligned plan must warn the alignment guards (2x karaoke + 1x exact): ${JSON.stringify(codesF)}`);
  });

  // 2. Plan-lint warning negatives (regression): chunk-too-long + emphasis-not-in-text.
  await step("save storyboard (caption warnings fixture)", async () => {
    const warny = JSON.parse(JSON.stringify(goodSb));
    warny.scenes[1].caption_segments[1].text = "this caption chunk is deliberately far too many words long";
    warny.scenes[1].caption_segments[2].emphasis_words = ["absent"];
    const s = await call("vob_save_storyboard", { project_id: CAP, content: warny });
    const codes = (s.plan_lint.warnings || []).map((w) => w.code);
    for (const c of ["PLAN_CAPTION_CHUNK_TOO_LONG", "PLAN_CAPTION_EMPHASIS_NOT_IN_TEXT"]) {
      assert(codes.includes(c), `expected ${c}, got ${JSON.stringify(codes)}`);
    }
  });

  await step("re-save good storyboard", () => call("vob_save_storyboard", { project_id: CAP, content: goodSb }));
  await step("confirm storyboard", () => call("vob_confirm_storyboard", { project_id: CAP }));
  await step("transition PLAN→COMPOSE", () => call("vob_transition_phase", { project_id: CAP, to_phase: "COMPOSE" }));

  const goodComp = composition(goodSb);

  // 3. Binding negative (regression): the EXACT caption with no element REJECTS.
  await step("save composition (exact caption missing element rejected)", async () => {
    const broken = { "index.html": goodComp["index.html"].replace(/^.*data-vob-caption-id="cx-1".*$\n/m, "") };
    assert(!/data-vob-caption-id="cx-1"/.test(broken["index.html"]), "fixture surgery failed — cx-1 still present");
    const err = await expectError("vob_save_composition", { project_id: CAP, files: broken }, /INVALID_ARGUMENTS/);
    const rules = (err.details.qc_findings || []).map((f) => f.rule);
    assert(rules.includes("vob/caption_missing_element"), `expected vob/caption_missing_element, got ${JSON.stringify(rules)}`);
  });

  // 4. Clean save: kit injected, layout-QC fold-in stamped, no errors.
  const savedComp = await step("save composition (caption kit + layout QC)", () =>
    call("vob_save_composition", { project_id: CAP, files: goodComp }),
  );
  {
    assert(savedComp.captions_kit_linked === true, "caption kit not linked into compose/");
    const manifestPath = path.join(savedComp.compose_dir, "captions", "manifest.json");
    assert(fs.existsSync(manifestPath), `compose/captions/manifest.json missing (expected ${manifestPath})`);
    const km = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert(km.animations && km.animations.karaoke && km.animations.karaoke.default, "caption manifest missing animations map");
    const reportPath = (savedComp.lint && savedComp.lint.report_path) || path.join(savedComp.compose_dir, "lint-report.json");
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert(report.report_version === 3, `expected lint-report report_version 3, got ${report.report_version}`);
    assert(report.inspect && typeof report.inspect === "object", "lint-report missing inspect{} block");
    if (HEAVY) {
      // Normally ran:true; tolerate a non-fatal DEGRADE (timeout/error) on a
      // loaded/low-RAM host — the heavy path proves the fold-in EXECUTES, and a
      // clean degrade IS the designed safe outcome (must never be an error).
      assert(report.inspect.ran === true || /^(timeout|error|unparseable)$/.test(String(report.inspect.skipped_reason || "")),
        `expected inspect to run or cleanly degrade under VOB_WALKER_LAYOUT_QC=1, got ${JSON.stringify(report.inspect)}`);
    } else {
      assert(report.inspect.ran === false && report.inspect.skipped_reason === "disabled",
        `expected inspect skipped:disabled under VOB_LAYOUT_QC=off, got ${JSON.stringify(report.inspect)}`);
    }
    assert(savedComp.lint_status !== "errors", `caption composition lint failed: ${savedComp.lint_status}`);
    console.log(`   captions_kit_linked: ${savedComp.captions_kit_linked}   report_version: ${report.report_version}   inspect: ${JSON.stringify(report.inspect)}   lint_status: ${savedComp.lint_status}`);

    // 4b. END-TO-END (HEAVY only, when inspect actually ran): inject an
    // ALWAYS-ON overflowing element into the REAL composition and prove the
    // inspect finding flows through save → lint → the merged report as an
    // ADVISORY warning that does NOT gate. Joins the two halves the cheap paths
    // prove in isolation. (The element is always-visible, NOT a timed caption:
    // the walker's stub timeline registers no real GSAP tweens, so inspect's
    // --at-transitions can't sample a narrow caption window — in real usage the
    // kit's gsap timelines DO create those tweens and timed captions get
    // measured. An unbound element with no planned-text match → layout_overflow.)
    if (HEAVY && report.inspect.ran === true) {
      await step("layout QC end-to-end: overflowing element folds into the lint report (no gate)", async () => {
        const overEl = `  <div id="lqc-overflow" class="clip" data-start="0" data-duration="${goodSb.total_target_duration_seconds}" data-track-index="5" style="position:absolute;top:80px;left:40px;width:200px;white-space:nowrap;font-family:Arial;font-size:300px;font-weight:900;color:#fff">OVERFLOWPROOF</div>`;
        const overComp = { "index.html": goodComp["index.html"].replace("</div>\n<script>", `${overEl}\n</div>\n<script>`) };
        assert(/lqc-overflow/.test(overComp["index.html"]), "fixture surgery failed — overflow element not injected");
        const s = await call("vob_save_composition", { project_id: CAP, files: overComp });
        const rp = (s.lint && s.lint.report_path) || path.join(s.compose_dir, "lint-report.json");
        const rep = JSON.parse(fs.readFileSync(rp, "utf8"));
        const rules = (rep.findings || []).map((f) => f.rule);
        assert(rules.includes("vob/caption_overflow") || rules.includes("vob/layout_overflow"),
          `expected an overflow finding folded into the lint report, got ${JSON.stringify(rules)} (inspect: ${JSON.stringify(rep.inspect)})`);
        assert(rep.lint_status !== "errors", `an overflow advisory must NOT gate (errors), got ${rep.lint_status}`);
        console.log(`   end-to-end overflow folded: ${rules.filter((r) => /overflow/.test(r)).join(", ")}   lint_status: ${rep.lint_status}`);
      });
    }
  }

  // 5. Layout-QC FIRING on tiny synthetic compositions (real `hyperframes
  // inspect`, no <video> — cheap). Three cases prove runner + parser + mapper
  // end-to-end without a session render: (a) an overflowing element whose text
  // matches a planned BOUND caption → vob/caption_overflow; (b) an overflowing
  // UNBOUND element (no caption id, no planned-text match) → vob/layout_overflow
  // (the re-chunked/unattributed fallback); (c) a fitting caption → nothing.
  // Each probe reaps its temp dir in a finally.
  await step("layout QC: synthetic overflow → caption_overflow + layout_overflow", async () => {
    assert(layoutQcMode() === (HEAVY ? "always" : "off"), "layoutQcMode did not honor VOB_LAYOUT_QC");
    const head = `<!doctype html><html><head><meta charset="utf-8"/><style>
html,body{margin:0;width:1080px;height:1920px;background:#111;overflow:hidden}
#root{position:relative;width:1080px;height:1920px}
.over{position:absolute;top:60px;left:40px;width:280px;white-space:nowrap;font-family:Arial;font-size:150px;font-weight:900;color:#fff}
.fit{position:absolute;bottom:200px;left:50%;transform:translateX(-50%);width:900px;text-align:center;font-family:Arial;font-size:60px;color:#fff}
</style></head><body>
<div id="root" data-composition-id="c" data-width="1080" data-height="1920" data-fps="30" data-start="0" data-duration="2">`;
    const wrap = (inner) => `${head}\n${inner}\n</div></body></html>`;
    const probe = async (inner, storyboard) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-lqc-"));
      try {
        fs.writeFileSync(path.join(dir, "index.html"), wrap(inner));
        const ins = await runInspect({ composeRoot: dir });
        const rep = parseInspectReport(ins.stdout);
        assert(rep.ok, `inspect report did not parse: ${rep.parse_error}`);
        return mapInspectIssues(rep, { storyboard });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };

    // (a) bound element + matching planned text -> caption_overflow.
    const BIG = "SUPERCALIFRAGILISTIC OVERFLOW HEADLINE";
    const sbBound = { schema_version: "1.0", scenes: [{ scene_id: "s001", source_clips: [], overlays: [],
      caption_segments: [{ text: BIG, start_seconds: 0, end_seconds: 2, id: "big" }] }] };
    const fBound = await probe(`<div class="over" data-vob-caption-id="big" data-start="0" data-duration="2">${BIG}</div>`, sbBound);
    assert(fBound.map((f) => f.rule).includes("vob/caption_overflow"), `expected vob/caption_overflow, got ${JSON.stringify(fBound)}`);
    assert(fBound.every((f) => f.severity !== "error"), "layout QC findings must never be errors");

    // (b) unbound element, no planned-text match -> layout_overflow (NOT caption).
    const fUnbound = await probe(`<div class="over" data-start="0" data-duration="2">UNPLANNEDOVERFLOWINGLAYOUTHEADLINE</div>`, sbBound);
    const rUnbound = fUnbound.map((f) => f.rule);
    assert(rUnbound.includes("vob/layout_overflow"), `expected vob/layout_overflow, got ${JSON.stringify(fUnbound)}`);
    assert(!rUnbound.includes("vob/caption_overflow"), `unattributed overflow must NOT be caption_overflow, got ${JSON.stringify(rUnbound)}`);

    // (c) fitting caption -> no overflow.
    const sbFit = { schema_version: "1.0", scenes: [{ scene_id: "s", source_clips: [], overlays: [],
      caption_segments: [{ text: "reads fine", start_seconds: 0, end_seconds: 2, id: "ok" }] }] };
    const fFit = await probe(`<div class="fit" data-vob-caption-id="ok" data-start="0" data-duration="2">reads fine</div>`, sbFit);
    assert(!fFit.some((f) => /overflow/.test(f.rule)), `clean caption must not overflow, got ${JSON.stringify(fFit)}`);

    // gating.
    assert(shouldRunLayoutQc(sbBound, {}) === true, "shouldRunLayoutQc should be true with a caption_segment");
    assert(shouldRunLayoutQc({ schema_version: "1.0", scenes: [{ scene_id: "s", source_clips: [], overlays: [] }] }, {}) === false,
      "shouldRunLayoutQc should be false with no captions/overlays");
  });

  const final = await call("vob_read_state_summary", { project_id: CAP });
  console.log(`\n=== captions final phase: ${final.phase}`);
  } finally {
    // Always restore the env knob (so a mid-phase throw can't leak it into a
    // later in-process phase).
    if (typeof prevLayoutQc === "string") process.env.VOB_LAYOUT_QC = prevLayoutQc;
    else delete process.env.VOB_LAYOUT_QC;
  }
}

// ---------------------------------------------------------------------------
// v3.3 `subject` walker phase — the subject-compositing executable spec:
// render_mode:"subject" schema gating + plan lint (the backdrop ingested-only
// guard + the host subject-seconds budget), the COMPOSE-entry matte
// materialization (content-hash cached, degrade-don't-die), and path (b) the
// ffmpeg composite (design-token backdrop + alpha matte + the SUBJECT's audio,
// duration-exact). The real matte (hyperframes remove-background — downloads a
// model + is RAM-heavy) is OPT-IN: set VOB_WALKER_MATTE=1 to run it. By default
// matting is disabled (VOB_REMOVE_BG_DISABLE) so the schema/lint/wiring tests run
// model-free and never surprise-download the model.

async function runSubject() {
  const SUB = `${PROJECT_ID}-subject`;
  console.log(`=== v3.3 subject walker (matted subject over backdrop) — project: ${SUB}`);
  const { transcodedClipPath, mattePath, matteSidecarPath } = require("../mcp/lib/paths.js");

  const wantMatte = /^(1|on|true|yes)$/i.test(process.env.VOB_WALKER_MATTE || "");
  const prevDisable = process.env.VOB_REMOVE_BG_DISABLE;
  if (!wantMatte) process.env.VOB_REMOVE_BG_DISABLE = "1"; // model-free by default
  else delete process.env.VOB_REMOVE_BG_DISABLE;

  function ffprobeJson(file) {
    const out = execFileSync("ffprobe",
      ["-v", "error", "-show_entries", "format=duration:stream=width,height,codec_type", "-of", "json", file],
      { encoding: "utf8" });
    return JSON.parse(out);
  }
  function ffprobeDims(file) {
    const j = ffprobeJson(file);
    const v = (j.streams || []).find((s) => s.codec_type === "video") || {};
    return { width: Number(v.width) || 1080, height: Number(v.height) || 1920, duration: Number(j.format && j.format.duration) || 0 };
  }
  function ffprobeHasAudio(file) {
    return (ffprobeJson(file).streams || []).some((s) => s.codec_type === "audio");
  }

  try {
    const boot = await bootstrapToPlan({
      projectId: SUB,
      target: { format: "tiktok", duration: "8s" },
      intentAnswers: {
        target_platform: "tiktok",
        target_duration: "8s",
        tone: "calm",
        key_moments: "none in particular",
        music_vo: "neither",
      },
      briefBody: `# Brief: ${SUB}\n\n## Target\n- 8s talking-head with a matted subject over a designed backdrop\n\n## Design language\n- Palette: bg #111111, text #F5F5F0, accent #8B5CF6\n`,
    });
    const D = boot.file0.duration_seconds;
    const srcPath = boot.file0.path || SOURCE;
    const windows = planWindows({ durationSeconds: D, transcript: null });

    const mkScene = (id, seq, purpose, win, secs, pacing) => ({
      scene_id: id, sequence: seq, purpose,
      target_duration_seconds: secs,
      summary: `${purpose} ${win.in}-${win.out}s`,
      source_clips: [{ manifest_file_index: 0, source_path: srcPath, in_seconds: win.in, out_seconds: win.out }],
      overlays: [], captions: null, pacing,
    });

    const hookWin = { ...windows.hook, out: round3(windows.hook.in + 4) };
    const payoffWin = { ...windows.payoff, out: round3(windows.payoff.in + 4) };
    // scene subj-1's clip is the SUBJECT footage matted off its background;
    // scene subj-2's clip-0 doubles as the clip_ref backdrop option (an INGESTED
    // clip, never a synthesized one).
    const goodSb = {
      schema_version: "1.2",
      project_id: SUB,
      generated_at: new Date().toISOString(),
      source: { manifest_path: boot.summary.manifest.path, brief_path: boot.savedBrief.brief_path },
      target: { platform: "tiktok", duration_seconds: 8, tone: "calm" },
      scenes: [
        mkScene("subj-1", 1, "hook", hookWin, 4, "medium"),
        mkScene("subj-2", 2, "payoff", payoffWin, 4, "medium"),
      ],
      total_target_duration_seconds: 8,
      broll_placements: [
        {
          render_mode: "subject",
          clip: { scene_id: "subj-1", clip_index: 0 },
          backdrop: { kind: "design_token", fill: "linear-gradient(180deg,#111111,#8B5CF6)" },
          position: { anchor: "center", scale: 0.82 },
          motion: { in: "fade", out: "fade" },
        },
      ],
      notes: "Subject walker fixture — matted talking-head over a design-token backdrop.",
    };

    // 1. Schema negative: a subject placement under schema 1.1 is rejected
    //    (render_mode rides the existing 1.2 gate).
    await step("save storyboard (subject under 1.1 rejected)", async () => {
      const old = JSON.parse(JSON.stringify(goodSb));
      old.schema_version = "1.1";
      const err = await expectError("vob_save_storyboard", { project_id: SUB, content: old }, /INVALID_ARGUMENTS/);
      assert((err.details.schema_errors || []).some((m) => /render_mode requires schema_version "1\.2"/.test(String(m))),
        `expected the render_mode 1.2 gate, got ${JSON.stringify(err.details.schema_errors)}`);
    });

    // 2. Schema negative: a subject on a gap placement is rejected (subject needs
    //    real footage to matte).
    await step("save storyboard (subject-on-gap rejected)", async () => {
      const bad = JSON.parse(JSON.stringify(goodSb));
      bad.broll_placements = [{ render_mode: "subject", source: "gap", description: "a shot we lack", desired_duration_seconds: 3, scene_ref: "subj-1" }];
      const err = await expectError("vob_save_storyboard", { project_id: SUB, content: bad }, /INVALID_ARGUMENTS/);
      assert((err.details.schema_errors || []).some((m) => /subject.*but is a gap/.test(String(m))),
        `expected the subject-on-gap error, got ${JSON.stringify(err.details.schema_errors)}`);
    });

    // 3. Plan-lint WARNING (save PASSES): a synthesized backdrop kind warns
    //    PLAN_SUBJECT_BACKDROP_NOT_INGESTED — the ingested-only guard at the gate.
    await step("save storyboard (synthesized backdrop kind warns, save stands)", async () => {
      const warny = JSON.parse(JSON.stringify(goodSb));
      warny.broll_placements[0].backdrop = { kind: "ai_generated", fill: "#000000" };
      const saved = await call("vob_save_storyboard", { project_id: SUB, content: warny });
      const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
      assert(saved.plan_lint.error_count === 0, "a synthesized-backdrop kind must NOT reject the save");
      assert(codes.includes("PLAN_SUBJECT_BACKDROP_NOT_INGESTED"),
        `expected PLAN_SUBJECT_BACKDROP_NOT_INGESTED, got ${JSON.stringify(codes)}`);
    });

    // 4. Budget echo: a tiny budget warns PLAN_SUBJECT_BUDGET_EXCEEDED.
    await step("save storyboard (subject budget exceeded warns)", async () => {
      const prev = process.env.VOB_SUBJECT_SECONDS_MAX;
      process.env.VOB_SUBJECT_SECONDS_MAX = "1";
      require("../mcp/lib/host-profile.js")._reset();
      try {
        const saved = await call("vob_save_storyboard", { project_id: SUB, content: goodSb });
        const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
        assert(codes.includes("PLAN_SUBJECT_BUDGET_EXCEEDED"),
          `expected PLAN_SUBJECT_BUDGET_EXCEEDED, got ${JSON.stringify(codes)}`);
      } finally {
        if (typeof prev === "string") process.env.VOB_SUBJECT_SECONDS_MAX = prev;
        else delete process.env.VOB_SUBJECT_SECONDS_MAX;
        require("../mcp/lib/host-profile.js")._reset();
      }
    });

    // 5. Good save: plan-lint clean of subject findings.
    const savedGood = await step("save storyboard (subject placement, no subject findings)", () =>
      call("vob_save_storyboard", { project_id: SUB, content: goodSb }));
    {
      assert(savedGood.plan_lint.error_count === 0, "good subject storyboard reported plan errors");
      const codes = (savedGood.plan_lint.warnings || []).map((w) => w.code);
      for (const code of ["PLAN_SUBJECT_BACKDROP_NOT_INGESTED", "PLAN_SUBJECT_BUDGET_EXCEEDED"]) {
        assert(!codes.includes(code), `good subject doc must not warn ${code}: ${JSON.stringify(codes)}`);
      }
    }

    await step("confirm storyboard", () => call("vob_confirm_storyboard", { project_id: SUB }));
    await step("transition PLAN→COMPOSE (materializes subject mattes)", () =>
      call("vob_transition_phase", { project_id: SUB, to_phase: "COMPOSE" }));

    const subjClip = transcodedClipPath(SUB, "subj-1", 0);
    assert(fs.existsSync(subjClip), `subject pre-cut clip missing at ${subjClip}`);

    const sum = await call("vob_read_state_summary", { project_id: SUB });
    assert(sum.subject_mattes && sum.subject_mattes.count === 1,
      `expected subject_mattes.count===1, got ${JSON.stringify(sum.subject_mattes)}`);
    console.log(`   subject_mattes: ${JSON.stringify(sum.subject_mattes)}`);

    const matteAbs = mattePath(SUB, "subj-1", 0);
    const sidecarAbs = matteSidecarPath(SUB, "subj-1", 0);

    if (!wantMatte) {
      // Model-free run: matting disabled -> the subject degrades to "skipped" but
      // COMPOSE is still entered (degrade-don't-die). No real matte produced.
      assert(sum.subject_mattes.skipped === 1,
        `disabled run should skip the matte, got ${JSON.stringify(sum.subject_mattes)}`);
      assert(sum.phase === "COMPOSE", `expected COMPOSE after transition, got ${sum.phase}`);
      console.log("\n   [SKIP] real-matte assertions — set VOB_WALKER_MATTE=1 (downloads the remove-background model; RAM-heavy) to run the matte + composite.");
      console.log(`\n=== subject final phase: ${sum.phase}`);
      return;
    }

    // --- Opt-in real-matte path (VOB_WALKER_MATTE=1) -------------------------
    await step("matte .webm + sidecar written at COMPOSE entry", () => {
      assert(fs.existsSync(matteAbs), `matte .webm missing at ${matteAbs}`);
      assert(fs.existsSync(sidecarAbs), `matte sidecar missing at ${sidecarAbs}`);
      assert((sum.subject_mattes.matted + sum.subject_mattes.cached) === 1,
        `expected a matted/cached subject, got ${JSON.stringify(sum.subject_mattes)}`);
    });

    await step("re-materialize reports cached (content-hash no-op)", async () => {
      const { materializeSubjectMattes } = require("../mcp/lib/matte-materialize.js");
      const again = await materializeSubjectMattes({ projectId: SUB });
      assert(again.summary.total === 1 && again.summary.cached === 1 && again.summary.matted === 0,
        `re-entry must be all-cached, got ${JSON.stringify(again.summary)}`);
    });

    await step("matte symlink resolves into compose/source", () => {
      const { resolveMatteLinks } = require("../mcp/lib/source-symlink.js");
      const links = resolveMatteLinks(SUB);
      assert(links.length === 1 && links[0].link_rel === "source/subj-1-0.webm",
        `expected one matte link source/subj-1-0.webm, got ${JSON.stringify(links)}`);
    });

    await step("path (b) ffmpeg composite — duration-exact + audio retained", async () => {
      const { generateBackdrop, compositeOverlayOverBase } = require("../mcp/lib/overlay-compositor.js");
      const dims = ffprobeDims(subjClip);
      const backdrop = `/tmp/${SUB}-backdrop.mp4`;
      await generateBackdrop({ fill: "#8B5CF6", width: dims.width, height: dims.height, durationSeconds: dims.duration, outPath: backdrop });
      const outComposite = `/tmp/${SUB}-subject.mp4`;
      await compositeOverlayOverBase({ basePath: backdrop, overlayPath: matteAbs, outPath: outComposite, audio: subjClip, scaleToBase: true });
      const cd = ffprobeDims(outComposite);
      const drift = Math.abs(cd.duration - dims.duration);
      assert(drift <= 0.5, `composite duration drift ${drift.toFixed(2)}s vs subject clip (${dims.duration}s)`);
      assert(ffprobeHasAudio(outComposite), "composite lost the subject audio (the subject's speech must win over the muted backdrop)");
      console.log(`   composite: ${cd.duration.toFixed(2)}s (subject ${dims.duration.toFixed(2)}s), audio retained`);
    });

    const final = await call("vob_read_state_summary", { project_id: SUB });
    console.log(`\n=== subject final phase: ${final.phase}`);
  } finally {
    if (typeof prevDisable === "string") process.env.VOB_REMOVE_BG_DISABLE = prevDisable;
    else delete process.env.VOB_REMOVE_BG_DISABLE;
  }
}

// ---------------------------------------------------------------------------
// v3.3 `transitions` walker phase — the PRD-02 executable spec: the typed
// transition vocabulary (per-preset), the ruleset-gated PLAN_TRANSITION_*
// warnings (all warnings, never errors), and render-plan GLUE boundary
// avoidance (a non-cut/non-seam transition_in keeps adjacent scenes in one
// render chunk; a seam-expressible transition_in at a chunk boundary becomes a
// dip-to-black). No renders here — the real-render duration-exactness of an
// intra-composition transition is structurally guaranteed (CSS paints over
// existing frames; master data-duration is unchanged) and proven end-to-end by
// the `longform` phase's assemble + ffprobe drift check.
async function runTransitions() {
  const TR = `${PROJECT_ID}-transitions`;
  console.log(`=== v3.3 transitions walker (PRD-02) — project: ${TR}`);

  const boot = await bootstrapToPlan({
    projectId: TR,
    target: { format: "tiktok", duration: "30 seconds" },
    intentAnswers: {
      target_platform: "tiktok",
      target_duration: "30 seconds",
      tone: "energetic",
      key_moments: "none in particular",
      music_vo: "neither",
    },
    briefBody: `# Brief: ${TR}\n\n## Target\n- tiktok, ~30s\n\n## Design language\n- Typography: headline Anton; captions Inter\n- Palette: bg #000 / text #FFF / accent #FF3B30\n- Motion: fast-snap\n`,
  });
  const D = boot.file0.duration_seconds;
  const srcPath = boot.file0.path || SOURCE;

  // tiktok ⇒ social-short; its transition_vocabulary is the CSS punchy family
  // (crossfade/whip_pan/zoom_punch/push — NO shader types). Both ride into the
  // composer spawn via the summary.
  await step("transition_vocabulary + shader gate surface in the summary", async () => {
    const s = await call("vob_read_state_summary", { project_id: TR });
    const tv = s.video_type.transition_vocabulary;
    assert(Array.isArray(tv) && tv.includes("crossfade") && tv.includes("whip_pan") && !tv.includes("glitch"),
      `unexpected transition_vocabulary: ${JSON.stringify(tv)}`);
    assert(typeof s.video_type.shader_transitions_allowed === "boolean",
      `shader_transitions_allowed must be a boolean, got ${JSON.stringify(s.video_type.shader_transitions_allowed)}`);
  });

  const ws = Array.from({ length: 8 }, (_, i) =>
    placeWindow({ keepSpans: null, len: 1.2, preferStart: D * (0.06 + i * 0.1), durationSeconds: D }));
  // A scene with TWO clips (video_count 2) + an optional transition_in.
  const trScene = (id, seq, purpose, pair, tin) => ({
    scene_id: id,
    sequence: seq,
    purpose,
    target_duration_seconds: 3,
    summary: `${purpose} ${id}`,
    source_clips: pair.map((w) => ({ manifest_file_index: 0, source_path: srcPath, in_seconds: w.in, out_seconds: w.out })),
    overlays: [],
    captions: null,
    pacing: "fast",
    ...(tin === undefined ? {} : { transition_in: tin }),
  });
  const sbEnvelope = (scenes) => ({
    schema_version: "1.2",
    project_id: TR,
    generated_at: new Date().toISOString(),
    source: { manifest_path: boot.summary.manifest.path, brief_path: boot.savedBrief.brief_path },
    target: { platform: "tiktok", duration_seconds: 12, tone: "energetic" },
    render_segmentation: "auto",
    scenes,
    total_target_duration_seconds: scenes.reduce((a, s) => a + s.target_duration_seconds, 0),
  });

  // CLEAN: A cut · B crossfade · C whip_pan (A-B-C glue) · D dip (a seam).
  const cleanScenes = [
    trScene("t001", 1, "hook", [ws[0], ws[1]], undefined),
    trScene("t002", 2, "beat", [ws[2], ws[3]], "crossfade"),
    trScene("t003", 3, "beat", [ws[4], ws[5]], "whip_pan"),
    trScene("t004", 4, "payoff", [ws[6], ws[7]], "dip"),
  ];
  await step("clean transitions (in-vocabulary) raise NO PLAN_TRANSITION warnings", async () => {
    const saved = await call("vob_save_storyboard", { project_id: TR, content: sbEnvelope(cleanScenes) });
    assert(saved.plan_lint.error_count === 0, `clean transitions storyboard reported plan-lint errors: ${JSON.stringify(saved.plan_lint)}`);
    const tcodes = (saved.plan_lint.warnings || []).map((w) => w.code).filter((c) => c.startsWith("PLAN_TRANSITION"));
    assert(tcodes.length === 0, `clean fixture should raise no PLAN_TRANSITION warnings, got ${JSON.stringify(tcodes)}`);
  });

  // NOISY (shaders forced off): an over-long crossfade, a shader type, an
  // off-vocabulary type. All three WARN; none is ever an error.
  const noisyScenes = [
    trScene("t001", 1, "hook", [ws[0], ws[1]], undefined),
    trScene("t002", 2, "beat", [ws[2], ws[3]], { type: "crossfade", duration_seconds: 5 }), // TOO_LONG (>0.5×3s)
    trScene("t003", 3, "beat", [ws[4], ws[5]], { type: "glitch" }),                          // BUDGET (shader, host off)
    trScene("t004", 4, "payoff", [ws[6], ws[7]], "iris"),                                    // UNKNOWN (off social-short vocab, not a seam)
  ];
  await step("noisy transitions WARN (TOO_LONG + BUDGET + UNKNOWN_TYPE), never error", async () => {
    const prev = process.env.VOB_SHADER_TRANSITIONS;
    process.env.VOB_SHADER_TRANSITIONS = "off";
    try {
      const saved = await call("vob_save_storyboard", { project_id: TR, content: sbEnvelope(noisyScenes) });
      assert(saved.plan_lint.error_count === 0, `transition warnings must NEVER be errors: ${JSON.stringify(saved.plan_lint)}`);
      const codes = (saved.plan_lint.warnings || []).map((w) => w.code);
      for (const c of ["PLAN_TRANSITION_TOO_LONG", "PLAN_TRANSITION_BUDGET", "PLAN_TRANSITION_UNKNOWN_TYPE"]) {
        assert(codes.includes(c), `expected ${c}, got ${JSON.stringify(codes.filter((x) => x.startsWith("PLAN_TRANSITION")))}`);
      }
    } finally {
      if (typeof prev === "string") process.env.VOB_SHADER_TRANSITIONS = prev;
      else delete process.env.VOB_SHADER_TRANSITIONS;
    }
  });

  // Re-save the CLEAN plan so the render plan derives from it, then sign off.
  await step("re-save clean storyboard", () => call("vob_save_storyboard", { project_id: TR, content: sbEnvelope(cleanScenes) }));
  await step("confirm storyboard", () => call("vob_confirm_storyboard", { project_id: TR }));

  // Render-plan boundary avoidance: under a deliberately low <video> budget the
  // GLUED run A-B-C must stay in ONE chunk (a plain budget pack of vc-2 scenes
  // would split 2+2); D starts the next chunk and the seam is D's dip → fade.
  await step("COMPOSE: glue keeps A-B-C in one chunk (3+1, not 2+2); D's dip ⇒ fade seam", async () => {
    const prev = process.env.VOB_VIDEO_BUDGET;
    process.env.VOB_VIDEO_BUDGET = "4";
    try {
      const toCompose = await call("vob_transition_phase", { project_id: TR, to_phase: "COMPOSE" });
      const rp = toCompose.phase_summary.render_plan;
      assert(rp && rp.mode === "segmented" && rp.segment_count === 2,
        `expected a 2-segment render plan, got ${JSON.stringify(rp)}`);
      assert(rp.segments[0].scene_count === 3 && rp.segments[1].scene_count === 1,
        `glue boundary avoidance failed — expected chunks of 3 then 1 scene, got ${rp.segments.map((s) => s.scene_count).join("+")}`);
      assert(rp.segments[0].transition_out === "fade",
        `the A-B-C chunk's seam should be a dip-to-black "fade" (D's dip transition_in), got "${rp.segments[0].transition_out}"`);
      console.log(`   plan: ${rp.segments.map((s) => `${s.segment_id}(${s.scene_count}sc)→${s.transition_out}`).join("  ")}`);
    } finally {
      if (typeof prev === "string") process.env.VOB_VIDEO_BUDGET = prev;
      else delete process.env.VOB_VIDEO_BUDGET;
    }
  });

  const final = await call("vob_read_state_summary", { project_id: TR });
  console.log(`\n=== transitions final phase: ${final.phase} — CSS @keyframes recipes in lint-rules.md; real-render duration-exactness covered by 'longform'`);
}

async function main() {
  const phase = process.argv[2] || "all";
  if (phase === "stillsqc") {
    await runStillsQc();
    return;
  }
  if (phase === "fanout") {
    await runFanout();
    return;
  }
  if (phase === "general") {
    await runGeneral();
    return;
  }
  if (phase === "longform") {
    await runLongform();
    return;
  }
  if (phase === "overlays") {
    await runOverlays();
    return;
  }
  if (phase === "gaps") {
    await runGaps();
    return;
  }
  if (phase === "captions") {
    await runCaptions();
    return;
  }
  if (phase === "subject") {
    await runSubject();
    return;
  }
  if (phase === "transitions") {
    await runTransitions();
    return;
  }
  console.log(`=== M5 walker v2 — phase: ${phase} — project: ${PROJECT_ID}`);

  if (phase === "setup" || phase === "all") {
    // 0. doctor preflight (warn-only — the walker itself is the smoke test)
    try {
      const doc = await step("doctor preflight", () => call("vob_doctor", {}));
      console.log(`   ok: ${doc.ok}   ${doc.summary || ""}`);
      for (const w of doc.warnings || []) console.log(`   warn: ${w.message || JSON.stringify(w)}`);
    } catch (e) {
      console.log(`   (doctor unavailable — continuing: ${e.message})`);
    }

    // 1. init (idempotent: skip if already created)
    try {
      await step("init project", () =>
        call("vob_init_project", { project_id: PROJECT_ID, target: { format: "tiktok", duration: "8s" } }),
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
      call("vob_ingest_file", { project_id: PROJECT_ID, source_path: SOURCE }),
    );
    const file0 = ingest.files[0];
    console.log(
      `   src: ${file0.duration_seconds.toFixed(1)}s ${file0.primary_video.width}x${file0.primary_video.height} ${file0.primary_video.codec}`,
    );
    if (Array.isArray(ingest.dependency_failures) && ingest.dependency_failures.length > 0) {
      console.log(`   dependency FAILURES: ${JSON.stringify(ingest.dependency_failures)}`);
    }
    if (ingest.rotation_warning) {
      console.log(`   rotation warning: ${JSON.stringify(ingest.rotation_warning)}`);
    }

    await step("transition INGEST→INSPECT", () =>
      call("vob_transition_phase", { project_id: PROJECT_ID, to_phase: "INSPECT" }),
    );

    // 2b. inspect — thumbnails, audio, transcript, segments, digest
    const inspect = await step("inspect (ffmpeg + ASR)", () =>
      call("vob_inspect_source", { project_id: PROJECT_ID }),
    );
    console.log(
      `   thumbs: ${inspect.thumb_count}   audio: ${inspect.audio_present ? "yes" : "no"}   speech: ${inspect.speech_detected ? `${inspect.word_count} words` : (inspect.skipped_reason || "none")}`,
    );
    if (inspect.digest_path) console.log(`   digest: ${inspect.digest_path}`);
    if (inspect.clean_speech_path) console.log(`   clean_speech: ${inspect.clean_speech_path}`);

    // 2c. canned classification (acting as inspector) when segments exist
    if (inspect.segment_count > 0) {
      const segmentsDoc = JSON.parse(fs.readFileSync(inspect.segments_path, "utf8"));
      const pools = cannedClassification(segmentsDoc);
      const cls = await step("save classification (canned)", () =>
        call("vob_save_classification", { project_id: PROJECT_ID, ...pools }),
      );
      console.log(`   pools: aroll ${cls.aroll_count}, broll ${cls.broll_count}, review ${cls.review_count}`);
    }

    await step("acknowledge inspect", () =>
      call("vob_acknowledge_inspect", { project_id: PROJECT_ID }),
    );
    await step("transition INSPECT→INTENT", () =>
      call("vob_transition_phase", { project_id: PROJECT_ID, to_phase: "INTENT" }),
    );

    // 3. plan the fixture windows off the real source + transcript
    let transcript = null;
    if (inspect.speech_detected && inspect.transcript_path && fs.existsSync(inspect.transcript_path)) {
      try {
        transcript = JSON.parse(fs.readFileSync(inspect.transcript_path, "utf8"));
      } catch { transcript = null; }
    }
    const speech = inspect.speech_detected === true && Array.isArray(transcript) && transcript.length > 0;
    const windows = planWindows({ durationSeconds: file0.duration_seconds, transcript });

    // 4. intent — 5 base keys, then the inspect-conditional keys; assert the
    //    missing-set drains to [] (C4 return shape) before transitioning.
    const intent = {
      target_platform: "tiktok",
      target_duration: "8s",
      tone: "cinematic",
      key_moments: `${windows.hook.in}-${windows.hook.out}s opening move, ${windows.payoff.in}-${windows.payoff.out}s payoff hold`,
      music_vo: "neither",
    };
    let lastRecord = null;
    for (const [k, v] of Object.entries(intent)) {
      lastRecord = await step(`record intent ${k}`, () =>
        call("vob_record_intent_answer", { project_id: PROJECT_ID, key: k, value: v }),
      );
    }
    let audioTreatment = null;
    if (inspect.audio_present) {
      audioTreatment = inspect.speech_detected ? "transcribe_captions" : "keep_ambient";
      lastRecord = await step(`record intent audio_treatment=${audioTreatment}`, () =>
        call("vob_record_intent_answer", { project_id: PROJECT_ID, key: "audio_treatment", value: audioTreatment }),
      );
      if (audioTreatment === "transcribe_captions") {
        lastRecord = await step("record intent captions_style", () =>
          call("vob_record_intent_answer", { project_id: PROJECT_ID, key: "captions_style", value: "bold sans, white, pill" }),
        );
      }
    }
    assert(
      Array.isArray(lastRecord.missing_required_keys) && lastRecord.missing_required_keys.length === 0,
      `intent keys not drained: ${JSON.stringify(lastRecord.missing_required_keys)}`,
    );

    await step("transition INTENT→PLAN", () =>
      call("vob_transition_phase", { project_id: PROJECT_ID, to_phase: "PLAN" }),
    );

    // 5. PLAN: brief (with the binding Design language section) + storyboard
    const briefText = brief({ ingestSummary: file0, intent, audioTreatment });
    const savedBrief = await step("save brief", () =>
      call("vob_save_brief", { project_id: PROJECT_ID, content: briefText }),
    );
    await step("confirm brief", () =>
      call("vob_confirm_brief", { project_id: PROJECT_ID }),
    );

    await step("log storyboarder invocation", () =>
      call("vob_log_storyboarder_invocation", { project_id: PROJECT_ID }),
    );
    const summary = await call("vob_read_state_summary", { project_id: PROJECT_ID });
    const sb = storyboard({
      manifestPath: summary.manifest.path,
      briefPath: savedBrief.brief_path,
      sourcePath: file0.path || SOURCE,
      windows,
      speech,
    });

    // 5a. NEGATIVE plan-lint fixture first: errors reject the save; warnings
    //     ride on the rejection so one revision pass fixes both.
    await step("save storyboard (negative plan-lint fixture)", async () => {
      const err = await expectError(
        "vob_save_storyboard",
        { project_id: PROJECT_ID, content: badStoryboard(sb, file0.duration_seconds) },
        /INVALID_ARGUMENTS|VALIDATION/,
      );
      const d = err.details || {};
      assert(Array.isArray(d.plan_errors) && d.plan_errors.length > 0, "rejection carried no plan_errors");
      assert(
        d.plan_errors.some((f) => f && f.code === "PLAN_CLIP_OUT_OF_BOUNDS"),
        `expected PLAN_CLIP_OUT_OF_BOUNDS in plan_errors, got ${JSON.stringify(d.plan_errors)}`,
      );
      assert(Array.isArray(d.plan_warnings), "rejection carried no plan_warnings");
      for (const code of ["PLAN_HOOK_NOT_FIRST", "PLAN_SCENE_SUM_MISMATCH"]) {
        assert(
          d.plan_warnings.some((f) => f && f.code === code),
          `expected ${code} in plan_warnings, got ${JSON.stringify(d.plan_warnings.map((f) => f && f.code))}`,
        );
      }
      assert(
        d.error_count >= d.plan_errors.length && d.warning_count >= d.plan_warnings.length,
        "error_count/warning_count do not cover the inline findings",
      );
      console.log(
        `\n   rejected as expected: ${d.error_count} error(s) [${d.plan_errors.map((f) => f.code).join(", ")}], ` +
        `${d.warning_count} warning(s) [${d.plan_warnings.map((f) => f.code).join(", ")}]`,
      );
    });

    // 5b. good storyboard — passed as an OBJECT (C8: object or string)
    const savedSb = await step("save storyboard (object, plan-lint-clean)", () =>
      call("vob_save_storyboard", { project_id: PROJECT_ID, content: sb }),
    );
    assert(savedSb.plan_lint && savedSb.plan_lint.error_count === 0, "good storyboard reported plan-lint errors");
    if (savedSb.plan_lint.warning_count > 0) {
      console.log(`   plan-lint warnings (${savedSb.plan_lint.warning_count}): ${(savedSb.plan_lint.warnings || []).map((w) => w.code).join(", ")}`);
    }
    await step("confirm storyboard", () =>
      call("vob_confirm_storyboard", { project_id: PROJECT_ID }),
    );

    // 6. COMPOSE entry pre-cuts every storyboard clip (blocking; cached)
    const toCompose = await step("transition PLAN→COMPOSE (pre-cut clips)", () =>
      call("vob_transition_phase", { project_id: PROJECT_ID, to_phase: "COMPOSE" }),
    );
    if (toCompose.clips) {
      console.log(
        `   clips: ${toCompose.clips.clip_count} (${toCompose.clips.cached_count} cached)   audio: ${toCompose.clips.audio_treatment}   dir: ${toCompose.clips.clips_dir}`,
      );
    }

    // 7. composition (acting as composer)
    await step("log composer invocation", () =>
      call("vob_log_composer_invocation", { project_id: PROJECT_ID }),
    );
    const comp = composition(sb);

    // 7a. NEGATIVE composition fixture: absolute src + missing
    //     data-composition-id must be rejected by save-time QC (C13).
    await step("save composition (negative QC fixture)", async () => {
      const err = await expectError(
        "vob_save_composition",
        { project_id: PROJECT_ID, files: badComposition(comp) },
        /INVALID_ARGUMENTS|QC/,
      );
      const d = err.details || {};
      assert(Array.isArray(d.qc_findings) && d.qc_findings.length > 0, "QC rejection carried no qc_findings");
      for (const rule of ["vob/missing_root_attr", "vob/absolute_src_path", "vob/unresolved_source_ref"]) {
        assert(
          d.qc_findings.some((f) => f && f.rule === rule),
          `expected ${rule} in qc_findings, got ${JSON.stringify(d.qc_findings.map((f) => f && f.rule))}`,
        );
      }
      // An unresolved ref must hand back the legal name list (no storyboard round-trip).
      assert(
        d.valid_source_refs && Array.isArray(d.valid_source_refs.scene_clips) && d.valid_source_refs.scene_clips.length > 0,
        "unresolved_source_ref rejection carried no valid_source_refs.scene_clips",
      );
      console.log(`\n   rejected as expected: ${d.qc_error_count} QC error(s) [${d.qc_findings.filter((f) => f.severity === "error").map((f) => f.rule).join(", ")}]   valid clips: ${d.valid_source_refs.scene_clips.join(", ")}`);
    });

    // 7b. good composition — engine recreates ./source/ symlinks + font kit
    const savedComp = await step("save composition (QC-clean)", () =>
      call("vob_save_composition", { project_id: PROJECT_ID, files: comp }),
    );
    assert(
      fs.existsSync(path.join(savedComp.compose_dir, "fonts.css")),
      "compose/fonts.css missing after save — font kit injection failed",
    );
    console.log(`   fonts linked: ${savedComp.fonts_linked}   qc warnings: ${savedComp.qc.warning_count}`);

    // 8. lint (hyperframes + QC merged)
    const lint = await step("lint composition", () =>
      call("vob_lint_composition", { project_id: PROJECT_ID }),
    );
    console.log(`   lint_status: ${lint.lint_status} (errors: ${lint.error_count}, warnings: ${lint.warning_count})   report: ${lint.report_path}`);
    if (lint.lint_status === "errors") {
      throw new Error("lint failed — see lint report");
    }

    // 8b. env-gated snapshot self-QC (C15: callable in COMPOSE, post-save)
    if (process.env.VOB_WALKER_SNAPSHOT === "1") {
      const hookMid = round3(sb.scenes[0].target_duration_seconds / 2);
      const beatMid = round3(sb.scenes[0].target_duration_seconds + sb.scenes[1].target_duration_seconds / 2);
      const snap = await step("snapshot keyframes (COMPOSE-phase self-QC)", () =>
        call("vob_snapshot_keyframes", { project_id: PROJECT_ID, timecodes: [hookMid, beatMid] }),
      );
      console.log(`   stills: ${snap.count}   contact sheet: ${snap.contact_sheet_path}`);
    }

    await step("transition COMPOSE→PREVIEW", () =>
      call("vob_transition_phase", { project_id: PROJECT_ID, to_phase: "PREVIEW" }),
    );
  }

  if (phase === "preview" || phase === "all") {
    // 9. preview render (slow — minutes)
    const preview = await step("render preview", () =>
      call("vob_render_preview", { project_id: PROJECT_ID }),
    );
    console.log(`   preview at ${preview.render_path}`);
    console.log(`   wall-clock: ${preview.render_duration_seconds.toFixed(1)}s   log: ${preview.stderr_log_path}`);
    if (preview.verification) {
      console.log(
        `   verification: drift ${preview.verification.duration_drift_seconds}s, ${preview.verification.width}x${preview.verification.height}`,
      );
    }
    await step("confirm preview", () =>
      call("vob_confirm_preview", { project_id: PROJECT_ID }),
    );
    await step("transition PREVIEW→RENDER", () =>
      call("vob_transition_phase", { project_id: PROJECT_ID, to_phase: "RENDER" }),
    );
  }

  if (phase === "render" || phase === "all") {
    // 10. full render (slower)
    const render = await step("render full", () =>
      call("vob_render_full", { project_id: PROJECT_ID }),
    );
    console.log(`   final at ${render.mp4_path}`);
    console.log(`   wall-clock: ${render.render_duration_seconds.toFixed(1)}s, size: ${(render.file_size_bytes / 1e6).toFixed(2)} MB`);
    console.log(`   log: ${render.stderr_log_path}`);
    if (render.verification) {
      console.log(
        `   verification: drift ${render.verification.duration_drift_seconds}s, ${render.verification.width}x${render.verification.height}`,
      );
    }
    await step("confirm render", () =>
      call("vob_confirm_render", { project_id: PROJECT_ID }),
    );
    await step("transition RENDER→PACKAGE", () =>
      call("vob_transition_phase", { project_id: PROJECT_ID, to_phase: "PACKAGE" }),
    );
  }

  if (phase === "package" || phase === "all") {
    // 11. package
    const pkg = await step("package output", () =>
      call("vob_package_output", { project_id: PROJECT_ID }),
    );
    console.log(`   ${pkg.directory_path}`);
    console.log(`   final:     ${pkg.final_mp4_path}`);
    console.log(`   thumbnail: ${pkg.thumbnail_path}`);
    console.log(`   manifest:  ${pkg.manifest_path}`);
    console.log(`   readme:    ${pkg.readme_path}`);

    await step("transition PACKAGE→ITERATE", () =>
      call("vob_transition_phase", { project_id: PROJECT_ID, to_phase: "ITERATE" }),
    );
    await step("finalize iteration", () =>
      call("vob_finalize_iteration", { project_id: PROJECT_ID }),
    );
  }

  const final = await call("vob_read_state_summary", { project_id: PROJECT_ID });
  console.log(`\n=== final phase: ${final.phase}   project: ${final.project_id}`);
}

main().catch((e) => {
  process.exitCode = 1;
  console.error("\nWALKER FAILED");
  console.error(e && e.stack ? e.stack : e);
});
