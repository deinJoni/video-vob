"use strict";

const REQUIRED_INTENT_KEYS = Object.freeze([
  "target_platform",
  "target_duration",
  "tone",
  "key_moments",
  "music_vo",
]);

const REQUIRED_INTENT_KEY_SET = new Set(REQUIRED_INTENT_KEYS);

function isValidIntentKey(key) {
  return typeof key === "string" && REQUIRED_INTENT_KEY_SET.has(key);
}

function missingIntentKeys(answers) {
  const present = answers && typeof answers === "object" && !Array.isArray(answers) ? answers : {};
  const missing = [];
  for (const key of REQUIRED_INTENT_KEYS) {
    const value = present[key];
    if (typeof value !== "string" || value.trim() === "") {
      missing.push(key);
    }
  }
  return missing;
}

module.exports = {
  REQUIRED_INTENT_KEYS,
  isValidIntentKey,
  missingIntentKeys,
};
