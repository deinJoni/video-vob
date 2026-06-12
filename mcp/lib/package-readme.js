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
