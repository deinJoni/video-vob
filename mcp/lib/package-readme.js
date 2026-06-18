"use strict";

function fmtSeconds(n) {
  if (!Number.isFinite(n)) return "unknown";
  if (n < 60) return `${n.toFixed(2)}s`;
  const mins = Math.floor(n / 60);
  const secs = (n - mins * 60).toFixed(1);
  return `${mins}m ${secs}s`;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDimensions(video) {
  if (!video) return "unknown";
  const w = Number(video.width);
  const h = Number(video.height);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return "unknown";
  return `${w}×${h}`;
}

function targetSummary(target) {
  if (!target || typeof target !== "object") return "(no target specified)";
  const parts = [];
  if (target.format) parts.push(`format ${target.format}`);
  if (target.duration) parts.push(`duration ${target.duration}`);
  return parts.length ? parts.join(", ") : "(no target specified)";
}

function renderPackageReadme(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("renderPackageReadme requires a manifest object");
  }
  const lines = [];
  const project = manifest.project_id || "(unknown project)";
  lines.push(`# ${project} — packaged video`);
  lines.push("");
  if (manifest.packaged_at) {
    lines.push(`_Packaged ${manifest.packaged_at}._`);
    lines.push("");
  }

  lines.push("## Output");
  lines.push("");
  lines.push(`- **Video:** \`${manifest.video?.path || "final.mp4"}\``);
  lines.push(`- **Duration:** ${fmtSeconds(manifest.video?.duration_seconds)}`);
  lines.push(`- **Dimensions:** ${fmtDimensions(manifest.video)}`);
  lines.push(`- **File size:** ${fmtBytes(manifest.video?.file_size_bytes)}`);
  lines.push("");

  if (manifest.thumbnail && manifest.thumbnail.path) {
    lines.push("## Thumbnail");
    lines.push("");
    lines.push(`- **Path:** \`${manifest.thumbnail.path}\``);
    if (Number.isFinite(manifest.thumbnail.extracted_at_seconds)) {
      const where = manifest.thumbnail.strategy === "hook_scene_midpoint"
        ? `${manifest.thumbnail.extracted_at_percent ?? "?"}% of duration; hook scene "${manifest.thumbnail.hook_scene_id ?? "?"}" midpoint`
        : `${manifest.thumbnail.extracted_at_percent ?? "?"}% of duration`;
      lines.push(`- **Frame at:** ${fmtSeconds(manifest.thumbnail.extracted_at_seconds)} (${where})`);
    }
    lines.push("");
  }

  // Posters (v3 PACKAGE): the canonical thumbnail (poster_0) plus the extra
  // output-time stills extracted at chapter starts / percent stops. Rendered
  // only when the manifest carries a non-empty posters set.
  if (manifest.posters && Array.isArray(manifest.posters.items) && manifest.posters.items.length > 0) {
    lines.push("## Posters");
    lines.push("");
    for (const poster of manifest.posters.items) {
      const pct = Number.isFinite(poster.extracted_at_percent) ? `${poster.extracted_at_percent}%, ` : "";
      let how;
      if (poster.strategy === "hook_scene_midpoint") how = "hook scene midpoint";
      else if (poster.strategy === "chapter_start") how = poster.label ? `chapter: ${poster.label}` : "chapter start";
      else if (poster.strategy === "percent_stop") how = `${poster.extracted_at_percent ?? "?"}% stop`;
      else how = poster.strategy || "frame";
      lines.push(`- **poster_${poster.index}** \`${poster.path}\` — ${fmtSeconds(poster.extracted_at_seconds)} (${pct}${how})`);
    }
    lines.push("");
    if (Array.isArray(manifest.posters.warnings) && manifest.posters.warnings.length > 0) {
      const n = manifest.posters.warnings.length;
      lines.push(`_(${n} extra poster${n === 1 ? "" : "s"} could not be extracted and ${n === 1 ? "was" : "were"} skipped.)_`);
      lines.push("");
    }
  }

  // Audio section: omitted entirely on a legacy (pre-v1.1) manifest.
  if (manifest.audio && typeof manifest.audio === "object") {
    lines.push("## Audio");
    lines.push("");
    if (manifest.audio.loudnorm_applied) {
      const measured = Number.isFinite(manifest.audio.measured_input_i)
        ? ` (measured ${manifest.audio.measured_input_i} LUFS at input)`
        : "";
      lines.push(`- **Loudness:** normalized to −14 LUFS / −1 dBTP${measured}`);
    } else {
      lines.push(`- **Loudness:** not normalized (${manifest.audio.skipped_reason || "unknown"})`);
    }
    lines.push("");
  }

  // Chapters (v3 long-form): from the storyboard's narrative segments. The
  // stamp list is paste-ready for a YouTube description (chapters need the
  // first stamp at 0:00 and ≥3 entries to show).
  if (Array.isArray(manifest.chapters) && manifest.chapters.length > 0) {
    lines.push("## Chapters");
    lines.push("");
    for (const ch of manifest.chapters) {
      lines.push(`${ch.youtube_stamp} ${ch.title}`);
    }
    lines.push("");
    if (manifest.chapters.length < 3) {
      lines.push("_(YouTube shows chapters only with 3+ entries starting at 0:00 — fewer are kept here for navigation/reference.)_");
      lines.push("");
    }
  }

  // Captions (v3 PACKAGE): the chunk-level soft-caption sidecars derived from
  // the storyboard's planned scene.caption_segments, timed off the scene
  // targets. Rendered only when the manifest carries a captions block.
  if (manifest.captions && typeof manifest.captions === "object") {
    lines.push("## Captions");
    lines.push("");
    lines.push(`- **SRT:** \`${manifest.captions.srt_path}\``);
    lines.push(`- **VTT:** \`${manifest.captions.vtt_path}\``);
    lines.push(`- **Cues:** ${manifest.captions.segment_count} (chunk-level, timed from storyboard targets)`);
    lines.push("");
  }

  // Distribution (v3 PACKAGE): the post-copy the human pastes into the upload
  // form — each present field rendered as its own fenced copy-paste block. The
  // header is printed only when at least one field is present; the description
  // fence appends the chapter stamps inline when chapters_paste_block is set, so
  // a YouTube long-form description is one paste. Empty fields are omitted.
  if (manifest.distribution && typeof manifest.distribution === "object") {
    const d = manifest.distribution;
    const hashtagsLine = typeof d.hashtags_line === "string" && d.hashtags_line.trim() !== ""
      ? d.hashtags_line
      : (Array.isArray(d.hashtags) && d.hashtags.length > 0 ? d.hashtags.join(" ") : null);
    const hasTitle = typeof d.title === "string" && d.title.trim() !== "";
    const hasDescription = typeof d.description === "string" && d.description.trim() !== "";
    const hasChaptersBlock = typeof d.chapters_paste_block === "string" && d.chapters_paste_block.trim() !== "";
    const hasHashtags = hashtagsLine !== null;
    const hasCta = typeof d.cta === "string" && d.cta.trim() !== "";
    if (hasTitle || hasDescription || hasChaptersBlock || hasHashtags || hasCta) {
      lines.push("## Distribution");
      lines.push("");
      if (hasTitle) {
        lines.push("**Title**");
        lines.push("");
        lines.push("```");
        lines.push(d.title);
        lines.push("```");
        lines.push("");
      }
      if (hasDescription || hasChaptersBlock) {
        lines.push("**Description**");
        lines.push("");
        lines.push("```");
        if (hasDescription) lines.push(d.description);
        if (hasChaptersBlock) {
          if (hasDescription) lines.push("");
          lines.push(d.chapters_paste_block);
        }
        lines.push("```");
        lines.push("");
      }
      if (hasHashtags) {
        lines.push("**Hashtags**");
        lines.push("");
        lines.push("```");
        lines.push(hashtagsLine);
        lines.push("```");
        lines.push("");
      }
      if (hasCta) {
        lines.push("**Call to action**");
        lines.push("");
        lines.push("```");
        lines.push(d.cta);
        lines.push("```");
        lines.push("");
      }
    }
  }

  // Aspect variants (v3 PACKAGE): the opt-in, labeled-lossy center-crop MP4s
  // produced under package/variants/. Rendered only when the manifest carries a
  // non-empty aspect_variants set. Each variant is an honest dumb-crop — the
  // edges are discarded — so the section leads with that warning and points at
  // the faithful --like path; it also names the single-timeline limitation.
  if (Array.isArray(manifest.aspect_variants) && manifest.aspect_variants.length > 0) {
    lines.push("## Aspect variants");
    lines.push("");
    for (const v of manifest.aspect_variants) {
      const dims = (Number.isFinite(v.width) && Number.isFinite(v.height)) ? ` (${v.width}×${v.height})` : "";
      lines.push(`- **${v.aspect}** \`${v.path}\`${dims} — \`${v.quality || "naive_crop"}\``);
    }
    lines.push("");
    lines.push("Center-crop only (`naive_crop`) — edges are discarded, which may clip captions or subjects. For a faithful re-frame, create a separate project with `--like <this project>` and the target platform.");
    lines.push("");
    lines.push("Aspect variants are single-timeline only; multi-short fan-out projects don't produce them.");
    lines.push("");
    if (Array.isArray(manifest.aspect_variant_warnings) && manifest.aspect_variant_warnings.length > 0) {
      const failed = manifest.aspect_variant_warnings.map((w) => w.aspect).filter(Boolean).join(", ");
      lines.push(`_(Could not produce: ${failed || "(unknown)"}.)_`);
      lines.push("");
    }
  }

  lines.push("## Target");
  lines.push("");
  lines.push(`- ${targetSummary(manifest.target)}`);
  lines.push("");

  if (manifest.source) {
    lines.push("## Source");
    lines.push("");
    if (manifest.source.primary_source_path) {
      lines.push(`- **Primary source:** \`${manifest.source.primary_source_path}\``);
    }
    if (Number.isFinite(manifest.source.file_count)) {
      lines.push(`- **Source files:** ${manifest.source.file_count}`);
    }
    if (manifest.source.ingest_manifest_path) {
      lines.push(`- **Ingest manifest:** \`${manifest.source.ingest_manifest_path}\``);
    }
    lines.push("");
  }

  if (manifest.lineage) {
    lines.push("## Lineage");
    lines.push("");
    const l = manifest.lineage;
    if (manifest.video_type && manifest.video_type.canonical) {
      lines.push(`- Video type: ${manifest.video_type.canonical} (${manifest.video_type.source})`);
    }
    if (manifest.assembly && Number.isFinite(manifest.assembly.segment_count)) {
      lines.push(`- Assembled from ${manifest.assembly.segment_count} render segment(s): ${manifest.assembly.segment_ids.join(", ")}${manifest.assembly.concat_path === "copy" ? " (lossless concat)" : ""}`);
      const m = manifest.assembly.music;
      if (m && m.file) {
        lines.push(`- Music bed: ${m.file}${Number.isFinite(m.gain_db) ? ` (${m.gain_db > 0 ? "+" : ""}${m.gain_db} dB)` : ""} — ${m.ducked ? "sidechain-ducked under program audio" : "**flat mix (NOT ducked)** — verify dialogue isn't masked"}`);
      }
    }
    if (Number.isFinite(l.storyboard_revision)) lines.push(`- Storyboard revision: ${l.storyboard_revision}`);
    if (Number.isFinite(l.composition_revision)) lines.push(`- Composition revision: ${l.composition_revision}`);
    if (Number.isFinite(l.preview_revision)) lines.push(`- Preview revision: ${l.preview_revision}`);
    if (Number.isFinite(l.render_revision)) lines.push(`- Render revision: ${l.render_revision}`);
    if (l.derived_from) lines.push(`- Styled after: ${l.derived_from}`);
    lines.push("");
  }

  if (manifest.render) {
    lines.push("## Render");
    lines.push("");
    if (manifest.render.engine) {
      const engine = manifest.render.engine_version
        ? `${manifest.render.engine} ${manifest.render.engine_version}`
        : manifest.render.engine;
      lines.push(`- **Engine:** ${engine}`);
    }
    if (manifest.render.rendered_at) lines.push(`- **Rendered at:** ${manifest.render.rendered_at}`);
    if (Number.isFinite(manifest.render.render_duration_seconds)) {
      lines.push(`- **Render wall-clock:** ${fmtSeconds(manifest.render.render_duration_seconds)}`);
    }
    lines.push("");
  }

  lines.push("## Iteration");
  lines.push("");
  lines.push(`- Iteration version: **${manifest.iteration_version ?? 1}**`);
  if (manifest.video_vob_version) {
    lines.push(`- Produced by video-vob ${manifest.video_vob_version}`);
  }
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("_This file is auto-generated from `manifest.json` by the MCP server. Do not edit by hand — it will be overwritten on the next package build._");
  lines.push("");

  return lines.join("\n");
}

module.exports = { renderPackageReadme };
