"use strict";

const { clipRoleOf, clipSpeedOf, effectiveClipDuration, storyboardHasShorts, storyboardTimelines } = require("./storyboard-schema.js");

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

// target.design (v3): the structured Design language tokens, rendered as a
// "Design" sub-block under Target so the human sees the look contract at the
// plan gate. Returns [] when absent.
function renderDesign(design) {
  if (!design || typeof design !== "object" || Array.isArray(design)) return [];
  const lines = [];
  const kv = (obj) => Object.entries(obj)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  if (design.typography && typeof design.typography === "object" && kv(design.typography)) {
    lines.push(`  - Typography: ${kv(design.typography)}`);
  }
  if (design.palette && typeof design.palette === "object" && kv(design.palette)) {
    lines.push(`  - Palette: ${kv(design.palette)}`);
  }
  const scalar = ["caption_style", "motion", "grade"]
    .filter((f) => typeof design[f] === "string" && design[f].trim() !== "")
    .map((f) => `${f.replace("_", " ")} ${design[f]}`)
    .join("; ");
  if (scalar) lines.push(`  - Look: ${scalar}`);
  if (lines.length > 0) lines.unshift("- Design:");
  return lines;
}

function renderClip(clip) {
  const note = typeof clip.note === "string" && clip.note.trim() !== "" ? ` — ${clip.note.trim()}` : "";
  const speed = clipSpeedOf(clip);
  // Show raw span and, when sped, the on-screen (output) length it becomes.
  const duration = speed !== 1
    ? `${formatSeconds(clip.out_seconds - clip.in_seconds)} @${speed}x → ${formatSeconds(effectiveClipDuration(clip))}`
    : formatSeconds(clip.out_seconds - clip.in_seconds);
  const role = clipRoleOf(clip);
  const roleTag = role === "a_roll" ? "" : ` **[${role.replace("_", "-").toUpperCase()}]**`;
  return `  - [file ${clip.manifest_file_index}]${roleTag} ${formatTimecode(clip.in_seconds)} → ${formatTimecode(clip.out_seconds)} (${duration}) \`${clip.source_path}\`${note}`;
}

function renderBrollPlacements(placements, heading = "##") {
  const lines = [];
  const gapCount = placements.filter((p) => p && p.source === "gap").length;
  lines.push(`${heading} B-roll placements (${placements.length})${gapCount > 0 ? ` — ⚠ ${gapCount} unfilled gap(s)` : ""}`);
  lines.push("");
  lines.push("_Cutaways laid over the A-roll/narration spine. Each references a `role:\"b_roll\"` clip already in the scenes above — or declares a **GAP**: coverage the ingested footage can't supply (upload matching footage and re-ingest to fill it)._");
  lines.push("");
  placements.forEach((p, ix) => {
    const span = p && p.narration_span
      ? ` over narration ${formatTimecode(p.narration_span.start_seconds)}→${formatTimecode(p.narration_span.end_seconds)}`
      : (typeof p.insert_at_seconds === "number" ? ` at ${formatTimecode(p.insert_at_seconds)}` : "");
    const reason = p && typeof p.reason === "string" && p.reason.trim() ? ` — ${p.reason.trim()}` : "";
    if (p && p.source === "gap") {
      const want = Number.isFinite(p.desired_duration_seconds) ? formatSeconds(p.desired_duration_seconds) : "?";
      lines.push(`${ix + 1}. **GAP** for scene ${p.scene_ref || "?"}: _"${p.description || "?"}"_ (~${want})${span}${reason}`);
      return;
    }
    const clip = p && p.clip ? p.clip : {};
    const ref = `${clip.scene_id || "?"}[${Number.isInteger(clip.clip_index) ? clip.clip_index : "?"}]`;
    const mode = p && typeof p.render_mode === "string" && p.render_mode !== "full_frame" ? ` **[${p.render_mode.toUpperCase()}]**` : "";
    const motion = p && typeof p.motion === "string" && p.motion.trim() && p.motion !== "none" ? ` ~${p.motion.trim()}` : "";
    const transition = p && typeof p.transition === "string" && p.transition.trim() ? ` (${p.transition.trim()})` : "";
    lines.push(`${ix + 1}. clip ${ref}${mode}${span}${motion}${transition}${reason}`);
  });
  lines.push("");
  return lines.join("\n");
}

function renderScene(scene, heading = "##") {
  const lines = [];
  // Non-default transitions only — plain cuts stay unannotated.
  const transitions = [];
  if (typeof scene.transition_in === "string" && scene.transition_in !== "cut") {
    transitions.push(`in: ${scene.transition_in}`);
  }
  if (typeof scene.transition_out === "string" && scene.transition_out !== "cut") {
    transitions.push(`out: ${scene.transition_out}`);
  }
  const transitionTag = transitions.length > 0 ? ` _(${transitions.join(", ")})_` : "";
  lines.push(`${heading} Scene ${scene.sequence}: ${scene.scene_id} — ${scene.purpose}${transitionTag}`);
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
    scene.overlays.forEach((entry) => {
      if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
        // Typed overlay (schema 1.2): planned, timed, composer-bound.
        const win = `${formatTimecode(entry.start_seconds)} → ${formatTimecode(entry.end_seconds)}`;
        const content = entry.content && typeof entry.content === "object"
          ? Object.entries(entry.content)
            .filter(([, v]) => typeof v === "string" || typeof v === "number")
            .slice(0, 3)
            .map(([k, v]) => `${k}: "${v}"`)
            .join(", ")
          : "";
        const pos = entry.position && typeof entry.position === "object" && entry.position.anchor
          ? ` @ ${entry.position.anchor}`
          : "";
        const motion = entry.motion && typeof entry.motion === "object" && (entry.motion.in || entry.motion.out)
          ? ` (${[entry.motion.in ? `in: ${entry.motion.in}` : null, entry.motion.out ? `out: ${entry.motion.out}` : null].filter(Boolean).join(", ")})`
          : "";
        lines.push(`  - **[${entry.type}]** \`${entry.id}\` ${win}${pos}${content ? ` — ${content}` : ""}${motion}`);
      } else {
        lines.push(`  - ${entry}`);
      }
    });
    lines.push("");
  }

  if (typeof scene.captions === "string" && scene.captions.trim() !== "") {
    lines.push(`**Captions:** ${scene.captions.trim()}`);
    lines.push("");
  }

  if (Array.isArray(scene.caption_segments) && scene.caption_segments.length > 0) {
    lines.push("**Caption segments:**");
    scene.caption_segments.forEach((seg) => {
      const emphasis = seg && seg.emphasis === true ? " **(emphasis)**" : "";
      const text = seg && typeof seg.text === "string" ? seg.text : "";
      const anim = seg && typeof seg.animation === "string" ? ` _${seg.animation}_` : "";
      const words = seg && Array.isArray(seg.emphasis_words) && seg.emphasis_words.length > 0
        ? ` — emphasize ${seg.emphasis_words.map((w) => `**${w}**`).join(", ")}`
        : "";
      lines.push(`  - ${formatTimecode(seg && seg.start_seconds)} → ${formatTimecode(seg && seg.end_seconds)} "${text}"${emphasis}${anim}${words}`);
    });
    lines.push("");
  }

  if (typeof scene.notes === "string" && scene.notes.trim() !== "") {
    lines.push(`**Notes:** ${scene.notes.trim()}`);
    lines.push("");
  }

  return lines.join("\n");
}

// options.planWarnings: plan-lint findings to surface at the plan gate.
// Back-compat: callable with one argument (walker, tests).
function renderStoryboardMarkdown(storyboard, options = {}) {
  if (!storyboard || typeof storyboard !== "object") {
    throw new Error("renderStoryboardMarkdown: storyboard must be an object");
  }
  const planWarnings = Array.isArray(options && options.planWarnings) ? options.planWarnings : [];
  const target = storyboard.target || {};
  const source = storyboard.source || {};
  const fanOut = storyboardHasShorts(storyboard);
  const timelines = storyboardTimelines(storyboard);
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  const shortsTotal = timelines.reduce(
    (acc, t) => acc + (Number.isFinite(t.total_target_duration_seconds) ? t.total_target_duration_seconds : 0),
    0,
  );

  const lines = [];
  lines.push(`# Storyboard: ${storyboard.project_id || "(unknown project)"}`);
  lines.push("");
  lines.push(`_Generated ${storyboard.generated_at || "(unknown)"}, schema ${storyboard.schema_version || "?"}_`);
  lines.push("");

  lines.push("## Target");
  lines.push(`- Platform: ${target.platform || "(?)"}`);
  lines.push(`- Duration${fanOut ? " (per-short ideal)" : ""}: ${formatSeconds(target.duration_seconds)}`);
  lines.push(`- Tone: ${target.tone || "(?)"}`);
  renderDesign(target.design).forEach((l) => lines.push(l));
  if (fanOut) {
    lines.push(`- Shorts: ${timelines.length}`);
    lines.push(`- Total target across shorts: ${formatSeconds(shortsTotal)}`);
  } else {
    lines.push(`- Total target across scenes: ${formatSeconds(storyboard.total_target_duration_seconds)}`);
  }
  lines.push("");

  if (planWarnings.length > 0) {
    lines.push(`## Plan warnings (${planWarnings.length})`);
    lines.push("");
    lines.push("_Flagged by plan lint — review at the plan gate; fix or accept explicitly._");
    lines.push("");
    planWarnings.slice(0, 25).forEach((w) => {
      const code = w && typeof w.code === "string" ? w.code : "WARNING";
      const message = w && typeof w.message === "string" ? w.message : String(w);
      lines.push(`- **${code}** — ${message}`);
    });
    lines.push("");
  }

  lines.push("## Source");
  lines.push(`- Manifest: \`${source.manifest_path || "(?)"}\``);
  lines.push(`- Brief: \`${source.brief_path || "(?)"}\``);
  lines.push("");

  if (fanOut) {
    timelines.forEach((timeline, ix) => {
      lines.push(`## Short ${ix + 1} of ${timelines.length}: ${timeline.short_id || "(?)"} — ${timeline.title || "(untitled)"} (${formatSeconds(timeline.total_target_duration_seconds)})`);
      lines.push("");
      timeline.scenes.forEach((scene) => {
        lines.push(renderScene(scene, "###"));
      });
      if (Array.isArray(timeline.broll_placements) && timeline.broll_placements.length > 0) {
        lines.push(renderBrollPlacements(timeline.broll_placements, "###"));
      }
      if (typeof timeline.notes === "string" && timeline.notes.trim() !== "") {
        lines.push(`**Short notes:** ${timeline.notes.trim()}`);
        lines.push("");
      }
    });
  } else {
    lines.push(`## Scenes (${scenes.length})`);
    lines.push("");
    scenes.forEach((scene) => {
      lines.push(renderScene(scene));
    });

    if (Array.isArray(storyboard.broll_placements) && storyboard.broll_placements.length > 0) {
      lines.push(renderBrollPlacements(storyboard.broll_placements));
    }
  }

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
