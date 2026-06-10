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

const QC_VIDEO_HARD_CAP = 8;
const QC_VIDEO_BUDGET = 6;
const QC_MASTER_DURATION_TOLERANCE_S = 0.5;
const QC_MEDIA_START_TOLERANCE_S = 0.05;
const QC_MIN_CAPTION_FONT_PX_VERTICAL = 56;
const QC_MIN_CAPTION_FONT_PX_SQUARE = 48;

// Tags whose src attribute is a media reference the file server must resolve.
const MEDIA_TAGS = new Set(["video", "audio", "img", "source"]);

// Opening-tag scan: tolerates multiline attribute blocks; a quoted ">" inside
// an attribute value does not terminate the tag.
const OPEN_TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'>]+))?/g;
const SOURCE_REF_RE = /^\.\/source\/(.+)$/;
const FONT_SIZE_PX_RE = /font-size\s*:\s*([0-9]+(?:\.[0-9]+)?)px/i;

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

// runCompositionQc({ files, storyboard, sourceLinks, sceneClipLinks, checkTargetsOnDisk })
//   files            [{ relPath, content }] — only .html/.css entries are inspected
//   storyboard       parsed storyboard.json object | null (null = unreadable/missing)
//   sourceLinks      resolveSourceLinks(id) tuples (may be [])
//   sceneClipLinks   resolveSceneClipLinks(id) tuples (may be [])
//   checkTargetsOnDisk  fs.existsSync each referenced link target when true
// => { findings: [{severity, rule, message, file, line, column, source:"vob"}],
//      error_count, warning_count }
function runCompositionQc({ files, storyboard, sourceLinks, sceneClipLinks, checkTargetsOnDisk }) {
  const findings = [];
  const fileList = Array.isArray(files)
    ? files.filter((f) => f && typeof f.relPath === "string" && typeof f.content === "string")
    : [];
  const cssFiles = fileList.filter((f) => /\.css$/i.test(f.relPath));
  const parsedFiles = fileList
    .filter((f) => /\.html$/i.test(f.relPath))
    .map((f) => ({ relPath: f.relPath, content: f.content, tags: extractTags(f.content) }));

  const sb = storyboard && typeof storyboard === "object" && !Array.isArray(storyboard) ? storyboard : null;
  const scenes = sb && Array.isArray(sb.scenes) ? sb.scenes : [];
  if (sb === null) {
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
          findings.push(makeFinding(
            "error",
            "vob/unresolved_source_ref",
            `src "./source/${name}" (${f.relPath}:${tag.line}) does not match any manifest source or storyboard scene clip — it will 404 at render (net::ERR_FILE_NOT_FOUND)`,
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

  // --- E6/W1: <video> element count -------------------------------------------
  if (videoCount > QC_VIDEO_HARD_CAP) {
    findings.push(makeFinding(
      "error",
      "vob/video_count_exceeds_hard_cap",
      `composition has ${videoCount} <video> elements (hard cap ${QC_VIDEO_HARD_CAP}) — headless Chrome on the reference host cannot survive this; concatenate the A-roll spine into one clip`,
    ));
  } else if (videoCount > QC_VIDEO_BUDGET) {
    findings.push(makeFinding(
      "warning",
      "vob/video_count_over_budget",
      `composition has ${videoCount} <video> elements (budget ${QC_VIDEO_BUDGET} on a low-RAM host) — consider concatenating spine clips`,
    ));
  }

  // --- W3: timed elements without class="clip" ---------------------------------
  for (const f of parsedFiles) {
    for (const tag of f.tags) {
      if (!("data-start" in tag.attrs) || !("data-duration" in tag.attrs)) continue;
      if ("data-composition-id" in tag.attrs) continue;
      const cls = tag.attrs.class;
      if (typeof cls === "string" && /\bclip\b/.test(cls)) continue;
      findings.push(makeFinding(
        "warning",
        "vob/timed_element_missing_clip_class",
        `${f.relPath}:${tag.line} <${tag.name}> has data-start/data-duration but no class="clip" — it will render static for the whole composition (pre-empting hyperframes lint timed_element_missing_clip_class)`,
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

  // Errors first (stable) so capped slices surface blockers before advice.
  findings.sort((a, b) => (a.severity === b.severity ? 0 : (a.severity === "error" ? -1 : 1)));

  let errorCount = 0;
  let warningCount = 0;
  for (const finding of findings) {
    if (finding.severity === "error") errorCount += 1;
    else warningCount += 1;
  }
  return { findings, error_count: errorCount, warning_count: warningCount };
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

module.exports = {
  QC_VIDEO_HARD_CAP,
  QC_VIDEO_BUDGET,
  QC_MASTER_DURATION_TOLERANCE_S,
  QC_MEDIA_START_TOLERANCE_S,
  QC_MIN_CAPTION_FONT_PX_VERTICAL,
  QC_MIN_CAPTION_FONT_PX_SQUARE,
  extractTags,
  runCompositionQc,
};
