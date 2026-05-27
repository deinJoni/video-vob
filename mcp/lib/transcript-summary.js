"use strict";

const SILENCE_GAP_SECONDS = 1.5;

function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

function wordText(entry) {
  if (typeof entry.text === "string") return entry.text;
  if (typeof entry.word === "string") return entry.word;
  return "";
}

function buildTranscriptSummary(transcript, { sourceLabel = "" } = {}) {
  const entries = (Array.isArray(transcript) ? transcript : [])
    .filter((e) => e && Number.isFinite(e.start) && Number.isFinite(e.end))
    .slice()
    .sort((a, b) => a.start - b.start);
  if (entries.length === 0) return { paragraphs: [], markdown: "" };

  const paragraphs = [];
  let current = {
    n: 1,
    start: entries[0].start,
    end: entries[0].end,
    words: [wordText(entries[0])],
  };
  for (let i = 1; i < entries.length; i += 1) {
    const prev = entries[i - 1];
    const e = entries[i];
    if (e.start - prev.end > SILENCE_GAP_SECONDS) {
      paragraphs.push({
        n: current.n,
        start: current.start,
        end: current.end,
        text: current.words.join(" ").replace(/\s+/g, " ").trim(),
      });
      current = { n: current.n + 1, start: e.start, end: e.end, words: [wordText(e)] };
    } else {
      current.end = e.end;
      current.words.push(wordText(e));
    }
  }
  paragraphs.push({
    n: current.n,
    start: current.start,
    end: current.end,
    text: current.words.join(" ").replace(/\s+/g, " ").trim(),
  });

  const sourceFragment = sourceLabel ? `Source: ${sourceLabel} · ` : "";
  const header = `# Transcript summary\n\n*${sourceFragment}${paragraphs.length} paragraph(s), split by silence gaps >${SILENCE_GAP_SECONDS}s. Reference paragraphs by number at INTENT (e.g. \`3\` or \`3, 5-7\`).*\n\n`;
  const body = paragraphs
    .map((p) => `## ${p.n} — ${formatTimestamp(p.start)} → ${formatTimestamp(p.end)}\n\n${p.text}\n`)
    .join("\n");

  return { paragraphs, markdown: header + body };
}

module.exports = { buildTranscriptSummary, SILENCE_GAP_SECONDS };
