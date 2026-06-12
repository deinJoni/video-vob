"use strict";

// Keyword-based grounding validator for brief.md. Not a critic — a guardrail.
// Catches the specific failure mode where a brief dresses a creative decision
// up as a fact about the source ("the audio is dropped — drone hum isn't
// useful") when the manifest shows audio is present and the user's INTENT
// answers did not authorize dropping it.

const DROP_AUDIO_PATTERNS = [
  /\bdrop(?:ped|ping)?\s+(?:the\s+|source\s+)?audio\b/i,
  /\b(?:source\s+)?audio\s+is\s+(?:also\s+)?dropped\b/i,
  /\bmute\s+(?:the\s+)?audio\b/i,
  /\bno\s+source\s+audio\b/i,
  /\bdiscard\s+(?:the\s+|source\s+)?audio\b/i,
  /\baudio\s+is\s+(?:not\s+used|removed|cut\s+entirely)\b/i,
];

const KEEP_AUDIO_TREATMENTS = new Set(["keep_audio", "transcribe_captions", "keep_ambient"]);

const BAKE_CAPTIONS_PATTERNS = [
  /\bburn(?:ed|ing|t|-?in)?[ \t-]*in\s+captions?\b/i,
  /\bburn(?:ed|ing|t)?[ \t-]*caption/i,
  /\bbaked[ \t-]*in\s+captions?\b/i,
  /\bhard[ \t-]?coded\s+captions?\b/i,
];

const CAPTIONS_REQUIRED_TREATMENTS = new Set(["keep_audio", "transcribe_captions"]);

function matchFirst(text, patterns) {
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[0];
  }
  return null;
}

function readManifestAudioCount(state) {
  // Prefer inspect summary if present; fall back to manifest video_stream_count
  // (which doesn't directly expose audio count — we recorded audio_streams in
  // ingest's per-file summary, not in the state.manifest header, so we use
  // inspect.audio_present as the authoritative signal in v1).
  if (state && state.inspect && state.inspect.audio_present === true) return 1;
  return 0;
}

function readAudioTreatment(state) {
  const answers = state && state.intent && state.intent.answers;
  if (!answers || typeof answers.audio_treatment !== "string") return null;
  return answers.audio_treatment.trim();
}

function validateBriefGrounding(briefText, state) {
  const violations = [];
  if (typeof briefText !== "string" || briefText.trim() === "") {
    return { ok: true, violations };
  }
  const audioCount = readManifestAudioCount(state);
  const audioTreatment = readAudioTreatment(state);

  // Rule 1: claiming to drop audio while audio is present and the intent
  // didn't authorize discarding it.
  if (audioCount > 0) {
    const dropMatch = matchFirst(briefText, DROP_AUDIO_PATTERNS);
    if (dropMatch && audioTreatment !== "discard_audio") {
      violations.push({
        code: "BRIEF_UNGROUNDED_AUDIO_CLAIM",
        message: `brief claims source audio is dropped/muted (matched: "${dropMatch}") but intent.audio_treatment is "${audioTreatment || "(unset)"}". To drop audio, set audio_treatment to "discard_audio" in INTENT first.`,
        matched_phrase: dropMatch,
        conflicts_with: "intent.audio_treatment",
        intent_value: audioTreatment,
      });
    }
  }

  // Rule 2: claiming burned-in captions without an audio_treatment that
  // authorizes them (only keep_audio or transcribe_captions imply captions).
  const bakeMatch = matchFirst(briefText, BAKE_CAPTIONS_PATTERNS);
  if (bakeMatch && !CAPTIONS_REQUIRED_TREATMENTS.has(audioTreatment)) {
    violations.push({
      code: "BRIEF_UNGROUNDED_CAPTIONS_CLAIM",
      message: `brief calls for burned-in captions (matched: "${bakeMatch}") but intent.audio_treatment is "${audioTreatment || "(unset)"}". Captions require audio_treatment in {keep_audio, transcribe_captions}; otherwise drop the captions claim.`,
      matched_phrase: bakeMatch,
      conflicts_with: "intent.audio_treatment",
      intent_value: audioTreatment,
    });
  }

  return { ok: violations.length === 0, violations };
}

module.exports = {
  validateBriefGrounding,
  // exported for testing
  DROP_AUDIO_PATTERNS,
  BAKE_CAPTIONS_PATTERNS,
};
