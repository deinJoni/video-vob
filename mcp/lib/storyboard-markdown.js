"use strict";

function formatSeconds(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "?";
  }
  if (Math.abs(value - Math.round(value)) < 1e-6) {
    return `${value.toFixed(0)}s`;
  }
  return `${value.toFixed(2)}s`;
}

function formatTimecode(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "?";
  }
  const total = Math.max(0, value);
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
}

function renderClip(clip) {
  const note = typeof clip.note === "string" && clip.note.trim() !== "" ? ` — ${clip.note.trim()}` : "";
  const duration = formatSeconds(clip.out_seconds - clip.in_seconds);
  return `  - [file ${clip.manifest_file_index}] ${formatTimecode(clip.in_seconds)} → ${formatTimecode(clip.out_seconds)} (${duration}) \`${clip.source_path}\`${note}`;
}

function renderScene(scene) {
  const lines = [];
  lines.push(`## Scene ${scene.sequence}: ${scene.scene_id} — ${scene.purpose}`);
  lines.push("");
  lines.push(`**Target duration:** ${formatSeconds(scene.target_duration_seconds)}  `);
  lines.push(`**Pacing:** ${scene.pacing}`);
  lines.push("");
  lines.push(scene.summary);
  lines.push("");

  if (Array.isArray(scene.source_clips) && scene.source_clips.length > 0) {
    lines.push("**Source clips:**");
    scene.source_clips.forEach((clip) => lines.push(renderClip(clip)));
    lines.push("");
  } else {
    lines.push("**Source clips:** _(none — overlay or generated transition)_");
    lines.push("");
  }

  if (Array.isArray(scene.overlays) && scene.overlays.length > 0) {
    lines.push("**Overlays:**");
    scene.overlays.forEach((entry) => lines.push(`  - ${entry}`));
    lines.push("");
  }

  if (typeof scene.captions === "string" && scene.captions.trim() !== "") {
    lines.push(`**Captions:** ${scene.captions.trim()}`);
    lines.push("");
  }

  if (typeof scene.notes === "string" && scene.notes.trim() !== "") {
    lines.push(`**Notes:** ${scene.notes.trim()}`);
    lines.push("");
  }

  return lines.join("\n");
}

function renderStoryboardMarkdown(storyboard) {
  if (!storyboard || typeof storyboard !== "object") {
    throw new Error("renderStoryboardMarkdown: storyboard must be an object");
  }
  const target = storyboard.target || {};
  const source = storyboard.source || {};
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];

  const lines = [];
  lines.push(`# Storyboard: ${storyboard.project_id || "(unknown project)"}`);
  lines.push("");
  lines.push(`_Generated ${storyboard.generated_at || "(unknown)"}, schema ${storyboard.schema_version || "?"}_`);
  lines.push("");

  lines.push("## Target");
  lines.push(`- Platform: ${target.platform || "(?)"}`);
  lines.push(`- Duration: ${formatSeconds(target.duration_seconds)}`);
  lines.push(`- Tone: ${target.tone || "(?)"}`);
  lines.push(`- Total target across scenes: ${formatSeconds(storyboard.total_target_duration_seconds)}`);
  lines.push("");

  lines.push("## Source");
  lines.push(`- Manifest: \`${source.manifest_path || "(?)"}\``);
  lines.push(`- Brief: \`${source.brief_path || "(?)"}\``);
  lines.push("");

  lines.push(`## Scenes (${scenes.length})`);
  lines.push("");
  scenes.forEach((scene) => {
    lines.push(renderScene(scene));
  });

  if (typeof storyboard.notes === "string" && storyboard.notes.trim() !== "") {
    lines.push("## Notes for COMPOSE");
    lines.push("");
    lines.push(storyboard.notes.trim());
    lines.push("");
  }

  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

module.exports = {
  renderStoryboardMarkdown,
};
