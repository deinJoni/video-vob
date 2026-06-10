#!/usr/bin/env node
"use strict";

// v2 walker — drives the FSM through executeTool (schema validation + the
// envelope, not bare handlers), modeling CURRENT conventions: scene clips
// ./source/sNNN-K.mp4 with data-media-start="0", class="clip" on every timed
// element, a plan-lint-clean storyboard, a QC-clean composition, and the font
// kit. Negative fixtures exercise the plan-lint and composition-QC rejection
// paths (errors AND warnings asserted), so this stays the executable spec.
//
// Phases: setup | preview | render | package | all. Heavy steps beyond setup
// are env-gated by invocation; the in-COMPOSE snapshot QC step is gated by
// VOB_WALKER_SNAPSHOT=1.

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
function composition(sb) {
  const total = sb.total_target_duration_seconds;
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
    cursor += scene.target_duration_seconds;
  }
  const index = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="./fonts.css">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1080px; height: 1920px; background: #000; font-family: "Inter", sans-serif; }
#master-root { position: relative; width: 1080px; height: 1920px; overflow: hidden; }
video.full-bleed { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
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
     data-width="1080"
     data-height="1920"
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

async function main() {
  const phase = process.argv[2] || "all";
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
