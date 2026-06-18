"use strict";

// Engine-side static QC over composer-emitted HTML/CSS (D6). Pure functions —
// no state reads, no locks; callers supply file contents + resolved link sets.
// Scope is the deterministically checkable failure classes on flat
// attribute-bearing HTML: Rule-of-Three attrs, dead ./source/ refs, absolute
// paths, master-duration truncation, scene coverage, <video> count. Rendered
// truth (contrast, safe bands, collisions, black frames) belongs to the
// snapshot self-QC loop, not here.

const fs = require("fs");
const path = require("path");

const { findTimeline, storyboardHasShorts, typedOverlaysOf, captionSegmentsOf } = require("./storyboard-schema.js");
const { transitionTypeOf } = require("./video-types.js");
const hostProfile = require("./host-profile.js");

// The <video>-element warn budget / hard cap are host-tunable (a big server
// survives more concurrent <video> than an 8GB Mac). Resolved per-process by
// host-profile.js: VOB_VIDEO_BUDGET/VOB_VIDEO_HARD_CAP env > host.json
// video_budget/video_hard_cap / capacity tier > built-in 6 / 8.
const QC_MASTER_DURATION_TOLERANCE_S = 0.5;
// The "too long" side is more tolerant — a brief deliberate hold on the last
// frame is a legitimate craft choice; only a clearly-accidental tail warns.
const QC_MASTER_DURATION_LONG_TOLERANCE_S = 1.0;
const QC_MEDIA_START_TOLERANCE_S = 0.05;
const QC_MIN_CAPTION_FONT_PX_VERTICAL = 56;
const QC_MIN_CAPTION_FONT_PX_SQUARE = 48;

// Tags whose src attribute is a media reference the file server must resolve.
const MEDIA_TAGS = new Set(["video", "audio", "img", "source"]);

// Tags the hyperframes clip-class lint rule skips (mirrored from the installed
// binary): the runtime schedules media off its own timing attrs — it discovers
// them via video[data-start]/audio[data-start] — so class="clip" visibility
// control applies to layout elements only. Timed media is not just legal, it is
// REQUIRED (media_missing_data_start is a lint ERROR on untimed <video src>).
const CLIP_CLASS_EXEMPT_TAGS = new Set(["audio", "video", "script", "style", "template"]);

// Opening-tag scan: tolerates multiline attribute blocks; a quoted ">" inside
// an attribute value does not terminate the tag.
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
const SOURCE_REF_RE = /^\.\/source\/(.+)$/;
const FONT_SIZE_PX_RE = /font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)px/i;
const FONT_FAMILY_RE = /font-family\s*:\s*([^;}{]+)/gi;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replace comment bodies with same-length whitespace (newlines preserved) so
// tag indices and line numbers computed afterwards stay true to the original.
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

function lineAt(text, index) {
  let line = 1;
  const bound = Math.min(index, text.length);
  for (let i = 0; i < bound; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

// Tag = { name: lowercased string, attrs: { [lowerAttrName]: string }, index, line }.
// Valueless attrs (e.g. `muted`) get value ""; first occurrence of an attr wins.
function extractTags(html) {
  const text = stripComments(String(html == null ? "" : html));
  const tags = [];
  OPEN_TAG_RE.lastIndex = 0;
  let m;
  while ((m = OPEN_TAG_RE.exec(text)) !== null) {
    const attrs = {};
    const attrText = m[2] || "";
    ATTR_RE.lastIndex = 0;
    let a;
    while ((a = ATTR_RE.exec(attrText)) !== null) {
      const attrName = a[1].toLowerCase();
      let value = "";
      if (a[2] !== undefined) {
        value = a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : a[2]);
      }
      if (!(attrName in attrs)) attrs[attrName] = value;
    }
    tags.push({ name: m[1].toLowerCase(), attrs, index: m.index, line: lineAt(text, m.index) });
  }
  return tags;
}

function makeFinding(severity, rule, message, file = null, line = null) {
  return { severity, rule, message, file, line, column: null, source: "vob" };
}

function isAbsoluteSrc(value) {
  return value.startsWith("/") || /^file:/i.test(value) || /^[A-Za-z]:\\/.test(value);
}

// runCompositionQc({ files, storyboard, sourceLinks, sceneClipLinks, checkTargetsOnDisk, activeShortId, activeSegment })
//   files            [{ relPath, content }] — only .html/.css entries are inspected
//   storyboard       parsed storyboard.json object | null (null = unreadable/missing)
//   sourceLinks      resolveSourceLinks(id) tuples (may be [])
//   sceneClipLinks   resolveSceneClipLinks(id) tuples (may be [])
//   layoutLinks      resolveLayoutLinks(id) tuples (may be []) — the composited
//                    <scene_id>-layout.mp4 split-screen clips
//   checkTargetsOnDisk  fs.existsSync each referenced link target when true
//   activeShortId    fan-out: the short this composition targets — scopes the
//                    scene-coverage/master-duration checks to that short's
//                    scenes and flags refs into OTHER shorts' clips
//   activeSegment    segmented render: { segment_id, scene_ids } — same scoping
//                    for the render segment this composition implements
// => { findings: [{severity, rule, message, file, line, column, source:"vob"}],
//      error_count, warning_count, expected_source_names, active_short_id,
//      active_segment_id }
function runCompositionQc({ files, storyboard, sourceLinks, sceneClipLinks, layoutLinks = null, checkTargetsOnDisk, activeShortId = null, activeSegment = null }) {
  const findings = [];
  const fileList = Array.isArray(files)
    ? files.filter((f) => f && typeof f.relPath === "string" && typeof f.content === "string")
    : [];
  const cssFiles = fileList.filter((f) => /\.css$/i.test(f.relPath));
  const parsedFiles = fileList
    .filter((f) => /\.html$/i.test(f.relPath))
    .map((f) => ({ relPath: f.relPath, content: f.content, tags: extractTags(f.content) }));

  const sb = storyboard && typeof storyboard === "object" && !Array.isArray(storyboard) ? storyboard : null;
  // Storyboard-conformance scope: the active short's scenes in fan-out, the
  // active render segment's scenes in segmented mode, the whole document
  // otherwise. activeSceneIdSet non-null marks scoped mode; scopeKind labels
  // the cross-reference warning.
  let scenes = [];
  let activeSceneIdSet = null;
  let scopeKind = null; // "short" | "segment"
  const segmentScope = activeSegment && typeof activeSegment === "object" && !Array.isArray(activeSegment)
    && typeof activeSegment.segment_id === "string" && Array.isArray(activeSegment.scene_ids)
    ? activeSegment
    : null;
  if (sb !== null) {
    if (storyboardHasShorts(sb)) {
      const timeline = findTimeline(sb, activeShortId);
      if (timeline) {
        scenes = timeline.scenes;
        activeSceneIdSet = new Set(
          scenes.map((s) => (s && typeof s.scene_id === "string" ? s.scene_id : null)).filter(Boolean),
        );
        scopeKind = "short";
      } else {
        findings.push(makeFinding(
          "warning",
          "vob/active_short_unresolved",
          `fan-out storyboard but no matching short for short_id ${activeShortId === null ? "(none)" : `"${activeShortId}"`} — skipped the scoped storyboard-conformance checks (master duration, scene coverage)`,
        ));
      }
    } else if (segmentScope !== null) {
      const allScenes = Array.isArray(sb.scenes) ? sb.scenes : [];
      const wanted = new Set(segmentScope.scene_ids.filter((id) => typeof id === "string" && id));
      const scoped = allScenes.filter((s) => s && typeof s.scene_id === "string" && wanted.has(s.scene_id));
      if (scoped.length === segmentScope.scene_ids.length && scoped.length > 0) {
        scenes = scoped;
        activeSceneIdSet = new Set(scoped.map((s) => s.scene_id));
        scopeKind = "segment";
      } else {
        // Plan/storyboard drifted apart (back-edge re-save without COMPOSE
        // re-entry) — fall back to whole-document checks rather than
        // mis-scoping against a dead segment.
        findings.push(makeFinding(
          "warning",
          "vob/active_segment_unresolved",
          `render segment "${segmentScope.segment_id}" no longer matches the storyboard scenes — re-enter COMPOSE to re-derive the render plan; ran whole-document conformance checks instead`,
        ));
        scenes = allScenes;
      }
    } else {
      scenes = Array.isArray(sb.scenes) ? sb.scenes : [];
    }
  } else {
    findings.push(makeFinding(
      "warning",
      "vob/storyboard_unreadable",
      "storyboard.json missing or unparseable — skipped storyboard-conformance checks (E2, E4, E5)",
    ));
  }

  // --- Roots (Rule of Three) -------------------------------------------------
  const indexFile = parsedFiles.find((f) => f.relPath === "index.html") || null;
  let masterRoot = null;
  const subRoots = [];
  if (indexFile) {
    for (const tag of indexFile.tags) {
      if (!("data-composition-id" in tag.attrs)) continue;
      if (masterRoot === null) masterRoot = { file: indexFile.relPath, tag };
      else subRoots.push({ file: indexFile.relPath, tag });
    }
  }
  for (const f of parsedFiles) {
    if (f === indexFile) continue;
    for (const tag of f.tags) {
      if ("data-composition-id" in tag.attrs) subRoots.push({ file: f.relPath, tag });
    }
  }
  // Discovery failure: hyperframes finds the composition by data-composition-id.
  // For the remaining numeric checks (master duration, vertical orientation) we
  // fall back to the first root-shaped tag in index.html so they still run.
  let effectiveMaster = masterRoot;
  if (masterRoot === null) {
    findings.push(makeFinding(
      "error",
      "vob/missing_root_attr",
      "index.html has no element with data-composition-id — hyperframes cannot discover the composition",
      "index.html",
      null,
    ));
    if (indexFile) {
      const fallback = indexFile.tags.find((t) => "data-width" in t.attrs || "data-height" in t.attrs || "data-duration" in t.attrs);
      if (fallback) effectiveMaster = { file: indexFile.relPath, tag: fallback };
    }
  }
  const pushRootAttrFindings = (root, isMaster) => {
    for (const attr of ["data-width", "data-height"]) {
      if (!(attr in root.tag.attrs)) {
        findings.push(makeFinding(
          "error",
          "vob/missing_root_attr",
          `composition root <${root.tag.name}@line ${root.tag.line}> is missing required attribute "${attr}" (Rule of Three / master duration)`,
          root.file,
          root.tag.line,
        ));
      }
    }
    if (isMaster) {
      const d = Number(root.tag.attrs["data-duration"]);
      if (!("data-duration" in root.tag.attrs) || !Number.isFinite(d) || d <= 0) {
        findings.push(makeFinding(
          "error",
          "vob/missing_root_attr",
          `composition root <${root.tag.name}@line ${root.tag.line}> is missing required attribute "data-duration" (Rule of Three / master duration)`,
          root.file,
          root.tag.line,
        ));
      }
    }
  };
  if (masterRoot) pushRootAttrFindings(masterRoot, true);
  for (const root of subRoots) pushRootAttrFindings(root, false);

  // --- Expected ./source/ name sets ------------------------------------------
  const sourceNames = new Map(); // basename -> source_abs|null
  for (const link of (Array.isArray(sourceLinks) ? sourceLinks : [])) {
    if (!link) continue;
    const name = typeof link.link_rel === "string" && link.link_rel.includes("/")
      ? link.link_rel.split("/").pop()
      : (typeof link.source_abs === "string" ? path.basename(link.source_abs) : null);
    if (name) sourceNames.set(name, typeof link.source_abs === "string" ? link.source_abs : null);
  }
  const clipNames = new Map(); // "<scene_id>-<k>.mp4" -> link tuple
  for (const link of (Array.isArray(sceneClipLinks) ? sceneClipLinks : [])) {
    if (!link || typeof link.scene_id !== "string" || !Number.isInteger(link.clip_index)) continue;
    clipNames.set(`${link.scene_id}-${link.clip_index}.mp4`, link);
  }
  // Multi-cell layout composites: "<scene_id>-layout.mp4" -> link tuple. The
  // composer references the composite as a single ./source/<scene_id>-layout.mp4
  // <video>; it resolves like a scene clip (disk + cross-scope checks).
  const layoutNames = new Map();
  for (const link of (Array.isArray(layoutLinks) ? layoutLinks : [])) {
    if (!link || typeof link.scene_id !== "string") continue;
    layoutNames.set(`${link.scene_id}-layout.mp4`, link);
  }
  // Resolution keeps ALL materialized clips (cross-short refs resolve on disk,
  // so they must not error as unresolved) — but the EXPECTED list handed to
  // the composer is the active short's clips when fan-out scoping is on.
  const expectedClipNameList = activeSceneIdSet
    ? [...clipNames.keys()].filter((n) => activeSceneIdSet.has(clipNames.get(n).scene_id))
    : [...clipNames.keys()];
  // Same active-scope filter for layout composite names in the suggestion list,
  // so a fan-out/segmented unresolved-ref doesn't suggest another short's layout.
  const expectedLayoutNameList = activeSceneIdSet
    ? [...layoutNames.keys()].filter((n) => activeSceneIdSet.has(layoutNames.get(n).scene_id))
    : [...layoutNames.keys()];

  // --- Media src scan ---------------------------------------------------------
  let videoCount = 0;
  const sourceRefNames = [];
  for (const f of parsedFiles) {
    for (const tag of f.tags) {
      if (tag.name === "video") videoCount += 1;
      if (!MEDIA_TAGS.has(tag.name)) continue;
      const src = tag.attrs.src;
      if (typeof src !== "string" || src === "") continue;

      if (isAbsoluteSrc(src)) {
        findings.push(makeFinding(
          "error",
          "vob/absolute_src_path",
          `src "${src}" (${f.relPath}:${tag.line}) is an absolute filesystem path — compositions must reference ./source/ (or ./fonts/) relative paths only`,
          f.relPath,
          tag.line,
        ));
        continue;
      }

      const refMatch = SOURCE_REF_RE.exec(src);
      if (!refMatch) continue;
      const name = refMatch[1];
      sourceRefNames.push(name);

      // E2/E2b need the expected-name set, which is wrong without a storyboard.
      if (sb !== null) {
        if (clipNames.has(name)) {
          const link = clipNames.get(name);
          if (checkTargetsOnDisk && typeof link.clip_abs === "string" && !fs.existsSync(link.clip_abs)) {
            findings.push(makeFinding(
              "error",
              "vob/source_ref_target_missing",
              `src "./source/${name}" (${f.relPath}:${tag.line}) refers to scene clip ${link.scene_id}-${link.clip_index} whose pre-cut file is missing at ${link.clip_abs} — re-enter COMPOSE to materialize clips`,
              f.relPath,
              tag.line,
            ));
          }
          if (activeSceneIdSet && !activeSceneIdSet.has(link.scene_id)) {
            findings.push(scopeKind === "segment"
              ? makeFinding(
                "warning",
                "vob/cross_segment_clip_ref",
                `src "./source/${name}" (${f.relPath}:${tag.line}) references scene clip ${link.scene_id}-${link.clip_index} belonging to ANOTHER render segment — a segment composition should use only its own scenes' clips (active segment: ${segmentScope.segment_id}); cross-segment footage duplicates content at assembly`,
                f.relPath,
                tag.line,
              )
              : makeFinding(
                "warning",
                "vob/cross_short_clip_ref",
                `src "./source/${name}" (${f.relPath}:${tag.line}) references scene clip ${link.scene_id}-${link.clip_index} belonging to ANOTHER short — a fan-out composition should use only the active short's clips (active: ${activeShortId})`,
                f.relPath,
                tag.line,
              ));
          }
        } else if (layoutNames.has(name)) {
          const link = layoutNames.get(name);
          if (checkTargetsOnDisk && typeof link.layout_abs === "string" && !fs.existsSync(link.layout_abs)) {
            findings.push(makeFinding(
              "error",
              "vob/source_ref_target_missing",
              `src "./source/${name}" (${f.relPath}:${tag.line}) refers to the layout composite for scene "${link.scene_id}" whose file is missing at ${link.layout_abs} — the layout materializer degraded (a malformed/failed composite); render the cells as positioned <video> elements instead, or re-enter COMPOSE`,
              f.relPath,
              tag.line,
            ));
          }
          if (activeSceneIdSet && !activeSceneIdSet.has(link.scene_id)) {
            findings.push(makeFinding(
              "warning",
              scopeKind === "segment" ? "vob/cross_segment_clip_ref" : "vob/cross_short_clip_ref",
              `src "./source/${name}" (${f.relPath}:${tag.line}) references the layout composite for scene "${link.scene_id}" belonging to ANOTHER ${scopeKind === "segment" ? `render segment (active: ${segmentScope.segment_id})` : `short (active: ${activeShortId})`}`,
              f.relPath,
              tag.line,
            ));
          }
        } else if (sourceNames.has(name)) {
          const sourceAbs = sourceNames.get(name);
          if (checkTargetsOnDisk && typeof sourceAbs === "string" && !fs.existsSync(sourceAbs)) {
            findings.push(makeFinding(
              "error",
              "vob/source_ref_target_missing",
              `src "./source/${name}" (${f.relPath}:${tag.line}) refers to a manifest source whose file is missing at ${sourceAbs} — the original source moved or was deleted`,
              f.relPath,
              tag.line,
            ));
          }
        } else {
          // List the legal names (scene clips first — they're what the composer
          // almost always meant; the ACTIVE short's clips in fan-out) so the
          // fix needs no storyboard re-derivation.
          const expected = [...expectedClipNameList, ...expectedLayoutNameList, ...sourceNames.keys()];
          const preview = expected.slice(0, 6).join(", ");
          const moreCount = expected.length - Math.min(6, expected.length);
          findings.push(makeFinding(
            "error",
            "vob/unresolved_source_ref",
            `src "./source/${name}" (${f.relPath}:${tag.line}) does not match any manifest source or storyboard scene clip — it will 404 at render (net::ERR_FILE_NOT_FOUND)${expected.length > 0 ? `. Expected one of: ${preview}${moreCount > 0 ? ` (+${moreCount} more)` : ""}` : ""}`,
            f.relPath,
            tag.line,
          ));
        }
      }

      // W2: non-zero data-media-start on a pre-cut scene clip. Membership in
      // sceneClipLinks OR the <scene_id>-<k>.mp4 naming convention (a name that
      // is NOT a manifest source) marks the ref as a scene clip — convention
      // matters so a typo'd clip name still gets the warning.
      if (tag.name === "video" || tag.name === "audio") {
        const isClip = clipNames.has(name) || (/-\d+\.mp4$/i.test(name) && !sourceNames.has(name));
        const mediaStart = Number(tag.attrs["data-media-start"]);
        if (isClip && Number.isFinite(mediaStart) && mediaStart > QC_MEDIA_START_TOLERANCE_S) {
          findings.push(makeFinding(
            "warning",
            "vob/scene_clip_media_start_nonzero",
            `${f.relPath}:${tag.line} scene clip "${name}" has data-media-start="${tag.attrs["data-media-start"]}" — pre-cut clips are already trimmed; non-zero offsets re-introduce the deep-seek failure mode`,
            f.relPath,
            tag.line,
          ));
        }
      }
    }
  }

  // --- E4: master duration vs storyboard scene total --------------------------
  if (sb !== null && effectiveMaster) {
    const masterDuration = Number(effectiveMaster.tag.attrs["data-duration"]);
    if (Number.isFinite(masterDuration)) {
      let sum = 0;
      for (const scene of scenes) {
        const d = Number(scene && scene.target_duration_seconds);
        if (Number.isFinite(d) && d > 0) sum += d;
      }
      if (sum > 0 && masterDuration < sum - QC_MASTER_DURATION_TOLERANCE_S) {
        findings.push(makeFinding(
          "error",
          "vob/master_duration_short",
          `master data-duration ${masterDuration}s is shorter than the storyboard scene total ${Math.round(sum * 1000) / 1000}s by more than ${QC_MASTER_DURATION_TOLERANCE_S}s — the timeline will truncate and the tail is silently dropped`,
          effectiveMaster.file,
          effectiveMaster.tag.line,
        ));
      } else if (sum > 0 && masterDuration > sum + QC_MASTER_DURATION_LONG_TOLERANCE_S) {
        // Symmetric to the short check, but a WARNING: an over-long master appends
        // frozen-last-frame / black tail (the timeline ends, the composition keeps
        // running). A brief intentional hold is legitimate, so it's not an error —
        // but a several-second tail is almost always an accident, and the composer
        // only sees this at save time (the post-render drift surprise is too late).
        findings.push(makeFinding(
          "warning",
          "vob/master_duration_long",
          `master data-duration ${masterDuration}s is longer than the storyboard scene total ${Math.round(sum * 1000) / 1000}s by more than ${QC_MASTER_DURATION_LONG_TOLERANCE_S}s — the render appends a frozen/black tail after the last scene. Trim data-duration to the scene total unless this hold is intentional`,
          effectiveMaster.file,
          effectiveMaster.tag.line,
        ));
      }
    }
  }

  // --- fps: storyboard target vs the master root's data-fps -------------------
  // hyperframes renders at data-fps (default 30 when absent). A cinematic
  // 24fps plan rendered at 30 is a silent format miss — warn, never block
  // (the render still succeeds; cadence is a craft call the user can accept).
  if (sb !== null && effectiveMaster) {
    const targetFps = sb.target && typeof sb.target === "object" ? Number(sb.target.fps) : NaN;
    if (Number.isFinite(targetFps) && targetFps > 0) {
      const rawAttr = effectiveMaster.tag.attrs["data-fps"];
      const masterFps = rawAttr === undefined ? 30 : Number(rawAttr);
      if (!Number.isFinite(masterFps) || Math.abs(masterFps - targetFps) > 0.01) {
        findings.push(makeFinding(
          "warning",
          "vob/fps_mismatch",
          `storyboard target.fps is ${targetFps} but the master root ${rawAttr === undefined ? "has no data-fps (hyperframes defaults to 30)" : `declares data-fps="${rawAttr}"`} — set data-fps="${targetFps}" on the composition root`,
          effectiveMaster.file,
          effectiveMaster.tag.line,
        ));
      }
    }
  }

  // --- E5: storyboard scene coverage (with the overlay-mode exemption) --------
  if (sb !== null) {
    const uncovered = [];
    for (const scene of scenes) {
      if (!scene || typeof scene.scene_id !== "string") continue;
      const clips = Array.isArray(scene.source_clips) ? scene.source_clips : [];
      if (clips.length === 0) continue; // overlay-only scenes exempt
      const prefix = `${scene.scene_id}-`;
      if (!sourceRefNames.some((n) => n.startsWith(prefix))) uncovered.push(scene);
    }
    if (uncovered.length > 0) {
      if (videoCount === 0) {
        // Zero <video> elements is the overlay-over-base signature (transparent
        // overlay rendered here, base cut with ffmpeg, composited via
        // vob_import_deliverable) — one warning, never errors.
        findings.push(makeFinding(
          "warning",
          "vob/overlay_scene_missing_clip",
          `overlay composition: ${uncovered.length} storyboard scene(s) have no clip element — confirm this is the overlay-over-base path (transparent overlay rendered here, base cut with ffmpeg, composited via vob_import_deliverable); if you meant to cut the timeline in hyperframes, add the scene clip elements`,
        ));
      } else {
        for (const scene of uncovered) {
          findings.push(makeFinding(
            "error",
            "vob/scene_missing_clip",
            `storyboard scene "${scene.scene_id}" (sequence ${scene.sequence}) has no clip element referencing ./source/${scene.scene_id}-*.mp4 — the scene would be missing from the render`,
          ));
        }
      }
    }
  }

  // --- Typed overlay binding (P3) ----------------------------------------------
  // Every PLANNED typed overlay (scoped scenes) must have an implementing
  // element stamped data-vob-overlay-id="<id>" — the plan is the binding
  // layer, same severity as scene coverage. Extra checks ride as warnings:
  // spine-track overlays, untimed elements, and composer-invented ids.
  if (sb !== null) {
    const planned = [];
    for (const scene of scenes) {
      if (!scene || typeof scene.scene_id !== "string") continue;
      for (const overlay of typedOverlaysOf(scene)) {
        if (overlay && typeof overlay.id === "string" && overlay.id) planned.push({ scene, overlay });
      }
    }
    const elementsByOverlayId = new Map();
    for (const f of parsedFiles) {
      for (const tag of f.tags) {
        const oid = tag.attrs["data-vob-overlay-id"];
        if (typeof oid === "string" && oid !== "" && !elementsByOverlayId.has(oid)) {
          elementsByOverlayId.set(oid, { file: f.relPath, tag });
        }
      }
    }
    for (const { scene, overlay } of planned) {
      const el = elementsByOverlayId.get(overlay.id);
      if (!el) {
        findings.push(makeFinding(
          "error",
          "vob/overlay_missing_element",
          `planned overlay ${overlay.type} "${overlay.id}" (scene "${scene.scene_id}") has no implementing element — render it and stamp the element with data-vob-overlay-id="${overlay.id}"`,
        ));
        continue;
      }
      const track = Number(el.tag.attrs["data-track-index"]);
      if (Number.isFinite(track) && track === 0) {
        findings.push(makeFinding(
          "warning",
          "vob/overlay_track_zero",
          `overlay "${overlay.id}" sits on data-track-index="0" (${el.file}:${el.tag.line}) — track 0 is the video spine; overlays belong on higher tracks`,
          el.file,
          el.tag.line,
        ));
      }
      if (!("data-start" in el.tag.attrs)) {
        findings.push(makeFinding(
          "warning",
          "vob/overlay_element_untimed",
          `overlay element for "${overlay.id}" (${el.file}:${el.tag.line}) has no data-start — it renders static for the whole composition instead of its planned ${overlay.start_seconds}–${overlay.end_seconds}s window`,
          el.file,
          el.tag.line,
        ));
      }
    }
    const plannedIds = new Set(planned.map((p) => p.overlay.id));
    for (const [oid, el] of elementsByOverlayId) {
      if (!plannedIds.has(oid)) {
        findings.push(makeFinding(
          "warning",
          "vob/unplanned_overlay_element",
          `element carries data-vob-overlay-id="${oid}" (${el.file}:${el.tag.line}) but the plan's active scope declares no such overlay — a typo'd id, or an overlay the storyboard didn't ask for`,
          el.file,
          el.tag.line,
        ));
      }
    }
  }

  // --- Scene transition realization (v3.3) — ADVISORY ONLY --------------------
  // A planned non-cut transition_in should leave SOME trace in the composition.
  // Unlike the overlay/exact-caption hard bindings, transitions are advisory: the
  // composer may realize a "whip pan" however it likes, and CSS @keyframes can't
  // be statically proven to animate. So this NEVER errors. Convention: stamp the
  // incoming scene's transition element with data-vob-transition="<type>" (and,
  // ideally, data-vob-transition-scene="<scene_id>"). If the composer adopts the
  // convention we check each planned scene is covered; if it ignores it entirely
  // we emit ONE gentle nudge rather than per-scene spam.
  if (sb !== null) {
    const plannedTransitions = [];
    scenes.forEach((scene, ix) => {
      if (!scene || typeof scene.scene_id !== "string" || ix === 0) return;
      const type = transitionTypeOf(scene.transition_in);
      if (type !== "cut") plannedTransitions.push({ scene_id: scene.scene_id, type });
    });
    if (plannedTransitions.length > 0) {
      const markedScenes = new Set();
      let anyMarker = false;
      for (const f of parsedFiles) {
        for (const tag of f.tags) {
          if ("data-vob-transition" in tag.attrs) {
            anyMarker = true;
            const sid = tag.attrs["data-vob-transition-scene"];
            if (typeof sid === "string" && sid) markedScenes.add(sid);
          }
        }
      }
      if (!anyMarker) {
        findings.push(makeFinding(
          "warning",
          "vob/transition_not_realized",
          `the plan declares ${plannedTransitions.length} non-cut scene transition(s) (e.g. ${plannedTransitions.slice(0, 3).map((t) => `${t.scene_id}:${t.type}`).join(", ")}) but no element carries data-vob-transition — if you realized them, stamp the incoming scene's transition element with data-vob-transition="<type>" data-vob-transition-scene="<scene_id>" so QC can confirm (advisory; transitions are NOT hard-bound)`,
        ));
      } else {
        for (const t of plannedTransitions) {
          if (!markedScenes.has(t.scene_id)) {
            findings.push(makeFinding(
              "warning",
              "vob/transition_not_realized",
              `planned "${t.type}" transition into scene "${t.scene_id}" has no matching data-vob-transition-scene="${t.scene_id}" element — confirm it was realized (advisory)`,
            ));
          }
        }
      }
    }
  }

  // --- Typed caption binding (P5) ---------------------------------------------
  // Captions are advisory by default — the composer legitimately re-chunks and
  // re-times them — so binding is OPT-IN: only a caption_segment carrying an
  // AUTHORED `id` (the storyboarder's signal "bind this one") is checked. A
  // missing element WARNS (vob/caption_unbound) unless the caption is exact:true
  // (a binding text/timing contract), which ERRORS (vob/caption_missing_element,
  // same severity as a missing overlay/scene clip). id-less captions are silent
  // — no derived ids, so a re-chunked caption set never floods the report.
  if (sb !== null) {
    const plannedCaptions = [];
    for (const scene of scenes) {
      if (!scene || typeof scene.scene_id !== "string") continue;
      for (const seg of captionSegmentsOf(scene)) {
        if (seg && typeof seg.id === "string" && seg.id) plannedCaptions.push({ scene, seg });
      }
    }
    if (plannedCaptions.length > 0) {
      const elementsByCaptionId = new Map();
      for (const f of parsedFiles) {
        for (const tag of f.tags) {
          const cid = tag.attrs["data-vob-caption-id"];
          if (typeof cid === "string" && cid !== "" && !elementsByCaptionId.has(cid)) {
            elementsByCaptionId.set(cid, { file: f.relPath, tag });
          }
        }
      }
      for (const { scene, seg } of plannedCaptions) {
        const el = elementsByCaptionId.get(seg.id);
        if (!el) {
          if (seg.exact === true) {
            findings.push(makeFinding(
              "error",
              "vob/caption_missing_element",
              `exact caption "${seg.id}" (scene "${scene.scene_id}": "${String(seg.text || "").slice(0, 40)}") has no implementing element — render it and stamp the element with data-vob-caption-id="${seg.id}" (exact:true makes it a binding contract)`,
            ));
          } else {
            findings.push(makeFinding(
              "warning",
              "vob/caption_unbound",
              `caption "${seg.id}" (scene "${scene.scene_id}") declares an id but no element carries data-vob-caption-id="${seg.id}" — stamp the implementing chunk, or drop the id if the composer is free to re-chunk it`,
            ));
          }
          continue;
        }
        if (!("data-start" in el.tag.attrs)) {
          findings.push(makeFinding(
            "warning",
            "vob/caption_element_untimed",
            `caption element for "${seg.id}" (${el.file}:${el.tag.line}) has no data-start — it renders static for the whole composition instead of its planned ${seg.start_seconds}–${seg.end_seconds}s window`,
            el.file,
            el.tag.line,
          ));
        }
      }
      const plannedCaptionIds = new Set(plannedCaptions.map((p) => p.seg.id));
      for (const [cid, el] of elementsByCaptionId) {
        if (!plannedCaptionIds.has(cid)) {
          findings.push(makeFinding(
            "warning",
            "vob/unplanned_caption_element",
            `element carries data-vob-caption-id="${cid}" (${el.file}:${el.tag.line}) but the plan's active scope declares no caption with that id — a typo'd id, or a caption the storyboard didn't ask to bind`,
            el.file,
            el.tag.line,
          ));
        }
      }
    }
  }

  // --- E6/W1: <video> element count -------------------------------------------
  const videoHardCap = hostProfile.videoHardCap();
  const videoBudget = hostProfile.videoBudget();
  if (videoCount > videoHardCap) {
    findings.push(makeFinding(
      "error",
      "vob/video_count_exceeds_hard_cap",
      `composition has ${videoCount} <video> elements (hard cap ${videoHardCap}) — headless Chrome on this host cannot survive this; concatenate the A-roll spine into one clip (raise the cap in .vob-config/host.json on a roomier machine)`,
    ));
  } else if (videoCount > videoBudget) {
    findings.push(makeFinding(
      "warning",
      "vob/video_count_over_budget",
      `composition has ${videoCount} <video> elements (budget ${videoBudget}) — consider concatenating spine clips (budget is host-tunable in .vob-config/host.json)`,
    ));
  }

  // --- W3: timed NON-media elements without class="clip" ------------------------
  // Exact mirror of the installed hyperframes lint rule: media/script/style/
  // template tags are exempt (CLIP_CLASS_EXEMPT_TAGS above), sub-composition
  // hosts (data-composition-src) are exempt like roots, the trigger is ANY of
  // data-start/data-duration/data-track-index, and the class check is an exact
  // token match. Diverging from the binary makes the two layers fight: the old
  // all-tags version warned on every timed <video> — an element hyperframes
  // REQUIRES to be timed — so every correct composition ate false positives.
  for (const f of parsedFiles) {
    for (const tag of f.tags) {
      if (CLIP_CLASS_EXEMPT_TAGS.has(tag.name)) continue;
      if ("data-composition-id" in tag.attrs || "data-composition-src" in tag.attrs) continue;
      const timed = "data-start" in tag.attrs || "data-duration" in tag.attrs || "data-track-index" in tag.attrs;
      if (!timed) continue;
      const cls = typeof tag.attrs.class === "string" ? tag.attrs.class : "";
      if (cls.split(/\s+/).includes("clip")) continue;
      findings.push(makeFinding(
        "warning",
        "vob/timed_element_missing_clip_class",
        `${f.relPath}:${tag.line} <${tag.name}> has timing attributes but no "clip" class token — it renders static for the whole composition instead of only its scheduled window (pre-empting hyperframes lint timed_element_missing_clip_class; <video>/<audio> are exempt — media is scheduled by its own timing attrs)`,
        f.relPath,
        tag.line,
      ));
    }
  }

  // --- W4: caption font-size floor on vertical/square compositions -------------
  // px-only by design: rem/em/vw/clamp() are skipped (no unit math, no false
  // positives). A later cascade rule overriding upward can false-positive — fine
  // at warn level; it can never block.
  captionFontSizeFindings({ parsedFiles, cssFiles, effectiveMaster, findings });

  // Design-language conformance (font kit). Document-global (no per-short /
  // per-segment design override), reads sb.target.design regardless of scope.
  {
    const design = sb && sb.target && typeof sb.target.design === "object"
      && sb.target.design !== null && !Array.isArray(sb.target.design)
      ? sb.target.design : null;
    designConformanceFindings({ parsedFiles, cssFiles, design, findings });
  }

  // Errors first (stable) so capped slices surface blockers before advice.
  findings.sort((a, b) => (a.severity === b.severity ? 0 : (a.severity === "error" ? -1 : 1)));

  let errorCount = 0;
  let warningCount = 0;
  for (const finding of findings) {
    if (finding.severity === "error") errorCount += 1;
    else warningCount += 1;
  }
  return {
    findings,
    error_count: errorCount,
    warning_count: warningCount,
    // Every legal ./source/ name, for callers that want to hand the composer
    // the full list on an unresolved-ref rejection (the findings cap at 6).
    // In fan-out / segmented mode, scene_clips is the ACTIVE scope's clip list.
    expected_source_names: {
      scene_clips: expectedClipNameList,
      layouts: [...layoutNames.keys()],
      sources: [...sourceNames.keys()],
    },
    active_short_id: activeShortId,
    active_segment_id: segmentScope ? segmentScope.segment_id : null,
  };
}

function captionFontSizeFindings({ parsedFiles, cssFiles, effectiveMaster, findings }) {
  if (!effectiveMaster) return;
  const w = Number(effectiveMaster.tag.attrs["data-width"]);
  const h = Number(effectiveMaster.tag.attrs["data-height"]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || h < w) return; // landscape skipped
  // Vertical (9:16 etc.) floor 56px; square (1:1) floor 48px.
  const minFontPx = h > w ? QC_MIN_CAPTION_FONT_PX_VERTICAL : QC_MIN_CAPTION_FONT_PX_SQUARE;
  const orientation = h > w ? "vertical" : "square";

  const captionClasses = new Set();
  for (const f of parsedFiles) {
    for (const tag of f.tags) {
      const cls = tag.attrs.class;
      if (typeof cls !== "string") continue;
      for (const token of cls.split(/\s+/)) {
        if (token && /caption/i.test(token)) captionClasses.add(token);
      }
    }
  }
  if (captionClasses.size === 0) return;

  const seen = new Set();
  const report = (selector, px, file, line) => {
    const key = `${file}:${line}:${selector}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(makeFinding(
      "warning",
      "vob/caption_font_size_small",
      `caption selector "${selector}" sets font-size ${px}px (${file}:${line}) — below the ${minFontPx}px floor for ${orientation}/short-form legibility`,
      file,
      line,
    ));
  };
  const scanCssText = (text, file, baseIndex, container) => {
    for (const cls of captionClasses) {
      const ruleRe = new RegExp(`([^{}]*\\.${escapeRegExp(cls)}[^{}]*)\\{([^}]*)\\}`, "g");
      let m;
      while ((m = ruleRe.exec(text)) !== null) {
        const fm = FONT_SIZE_PX_RE.exec(m[2]);
        if (!fm) continue;
        const px = Number(fm[1]);
        if (Number.isFinite(px) && px < minFontPx) {
          report(m[1].trim(), px, file, lineAt(container, baseIndex + m.index));
        }
      }
    }
  };

  for (const f of cssFiles) scanCssText(f.content, f.relPath, 0, f.content);
  const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (const f of parsedFiles) {
    STYLE_BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = STYLE_BLOCK_RE.exec(f.content)) !== null) {
      scanCssText(m[1], f.relPath, m.index + m[0].indexOf(m[1]), f.content);
    }
  }
  for (const f of parsedFiles) {
    for (const tag of f.tags) {
      const cls = tag.attrs.class;
      const style = tag.attrs.style;
      if (typeof cls !== "string" || typeof style !== "string") continue;
      const tokens = cls.split(/\s+/);
      const captionToken = tokens.find((t) => captionClasses.has(t));
      if (!captionToken) continue;
      const fm = FONT_SIZE_PX_RE.exec(style);
      if (!fm) continue;
      const px = Number(fm[1]);
      if (Number.isFinite(px) && px < minFontPx) {
        report(`.${captionToken}`, px, f.relPath, tag.line);
      }
    }
  }
}

// Document-global font-kit conformance (WARNING-only). design.typography
// declares the kit families the composition should use (headline/caption/
// body/…). If the composition uses font-family AT ALL but references NONE of the
// declared families, the composer went off-brief — warn once. Referencing at
// least one declared family counts as adherence (a montage that only renders the
// headline face is fine). No-ops when target.design.typography is absent or the
// composition declares no font-family (nothing to judge). Accent/grade/motion
// conformance is deliberately NOT checked — too fuzzy to surface without noise.
function designConformanceFindings({ parsedFiles, cssFiles, design, findings }) {
  if (!design || typeof design.typography !== "object"
    || design.typography === null || Array.isArray(design.typography)) return;
  const declared = new Map(); // normalized family -> original spelling
  for (const v of Object.values(design.typography)) {
    if (typeof v === "string" && v.trim()) declared.set(v.trim().toLowerCase(), v.trim());
  }
  if (declared.size === 0) return;

  const used = new Set();
  const collect = (cssText) => {
    if (typeof cssText !== "string" || cssText === "") return;
    FONT_FAMILY_RE.lastIndex = 0;
    let m;
    while ((m = FONT_FAMILY_RE.exec(cssText)) !== null) {
      for (const fam of m[1].split(",")) {
        const norm = fam.trim().replace(/^['"]+|['"]+$/g, "").trim().toLowerCase();
        if (norm) used.add(norm);
      }
    }
  };
  for (const f of cssFiles) collect(f.content);
  const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  for (const f of parsedFiles) {
    STYLE_BLOCK_RE.lastIndex = 0;
    let m;
    while ((m = STYLE_BLOCK_RE.exec(f.content)) !== null) collect(m[1]);
    for (const tag of f.tags) collect(tag.attrs.style);
  }
  if (used.size === 0) return; // composition declares no fonts — nothing to judge

  let usedDeclaredCount = 0;
  for (const lower of declared.keys()) {
    if (used.has(lower)) usedDeclaredCount += 1;
  }
  if (usedDeclaredCount === 0) {
    findings.push(makeFinding(
      "warning",
      "vob/design_font_mismatch",
      `the storyboard's design language declares the font kit ${JSON.stringify([...declared.values()])} (target.design.typography) but the composition's font-family declarations reference none of them — the composer used off-brief type. Use the declared kit families (loaded via ./fonts.css)`,
    ));
    return;
  }
  // Adheres to at least one declared family, but collapsed a multi-role type
  // system (headline/body/caption) down to a SINGLE face — reads as templated
  // "AI slop", the exact thing the design layer is meant to prevent. INFO (a
  // non-gating, low-noise nudge; the all-or-nothing mismatch above stays a warning).
  if (usedDeclaredCount === 1 && declared.size >= 2) {
    findings.push(makeFinding(
      "info",
      "vob/design_font_partial",
      `the design language declares ${declared.size} type roles ${JSON.stringify([...declared.values()])} but the composition uses only one of them — the headline/body/caption hierarchy is flattened to a single face, which reads as templated. Render the distinct declared faces in their roles`,
    ));
  }
}

module.exports = {
  QC_MASTER_DURATION_TOLERANCE_S,
  QC_MEDIA_START_TOLERANCE_S,
  QC_MIN_CAPTION_FONT_PX_VERTICAL,
  QC_MIN_CAPTION_FONT_PX_SQUARE,
  extractTags,
  runCompositionQc,
};
