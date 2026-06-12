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
// longform | overlays | gaps. Heavy steps beyond setup are env-gated by
// invocation; the in-COMPOSE snapshot QC step is gated by VOB_WALKER_SNAPSHOT=1.
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

const { executeTool } = require("../mcp/lib/dispatch.js");

const PROJECT_ID = process.env.VOB_WALKER_PROJECT || "dji-aerial";
// No bundled fixture (this is a template repo). Point the walker at any local
// video file ≥15s via VOB_WALKER_SOURCE:
//   VOB_WALKER_SOURCE=/path/to/clip.mp4 node scripts/m5-walker.js [phase]
const SOURCE = process.env.VOB_WALKER_SOURCE || "";
if (!SOURCE) {
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
              { text: "walker caption one", start_seconds: round3(windows.beat.in + 0.2), end_seconds: round3(windows.beat.in + 1.4) },
              { text: "walker caption two", start_seconds: round3(windows.beat.in + 1.5), end_seconds: round3(windows.beat.in + 2.8), emphasis: true },
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
    target: { platform: "tiktok", duration_seconds: 8, tone: "cinematic" },
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
        captionDivs.push(
          `  <div id="caption-${captionIx}" class="clip caption" data-start="${start}" data-duration="${dur}" data-track-index="3"><span>${seg.text}</span></div>`,
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
        });
      }
    }
  }
  return {
    aroll_pool: { segments: aroll },
    broll_index: { clips: broll },
    review: { segments: [] },
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
  if (inspect.segment_count > 0) {
    const segmentsDoc = JSON.parse(fs.readFileSync(inspect.segments_path, "utf8"));
    await step("save classification (canned)", () =>
      call("vob_save_classification", { project_id: projectId, ...cannedClassification(segmentsDoc) }),
    );
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

function generalScene({ sceneId, sequence, purpose, win, targetSeconds, sourcePath }) {
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
    pacing: "medium",
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

  // 7. Clean save: every planned overlay bound, no overlay findings, lint runs.
  const savedComp = await step("save composition (overlay layer, QC-clean)", () =>
    call("vob_save_composition", { project_id: OV, files: goodComp }),
  );
  {
    const rules = savedComp.qc.findings.map((f) => f.rule);
    assert(!rules.some((r) => /overlay/.test(r)), `clean save must carry no overlay findings, got ${JSON.stringify(rules)}`);
    console.log(`   lint_status: ${savedComp.lint_status || "(infra fallback)"}   qc warnings: ${savedComp.qc.warning_count}`);
    if (savedComp.lint_status === "errors") throw new Error("overlay composition lint failed");
  }

  const final = await call("vob_read_state_summary", { project_id: OV });
  console.log(`\n=== overlays final phase: ${final.phase}`);
}

async function main() {
  const phase = process.argv[2] || "all";
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
