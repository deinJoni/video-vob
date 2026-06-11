"use strict";

// Small concurrency utilities shared by batch/fan-out operations.
//
// WHY: heavy H.264 encodes of large vertical frames (e.g. 1512×2688) are
// memory-hungry; running ≥5 of them at once has been observed to get
// SIGKILL'd by the OOM killer on constrained hosts. Any vob path that encodes
// MANY clips/deliverables must cap concurrency to a RAM-derived ceiling rather
// than fan out unbounded. (The single-timeline COMPOSE pre-cut is already
// serial; this guards the multi-deliverable / overlay paths and is surfaced as
// a recommendation by vob_doctor.)

const { encodeConcurrency } = require("./host-profile.js");

// Recommended simultaneous heavy (full-res H.264) encodes for this host.
// Resolution (host-profile.js): VOB_ENCODE_CONCURRENCY env > host.json
// encode_concurrency / capacity tier > RAM-derived default (<10 GB -> 1,
// <20 GB -> 2, else 3). Tune per machine in .vob-config/host.json.
function recommendedHeavyEncodeConcurrency() {
  return encodeConcurrency();
}

// Run `fn(item, index)` over `items` with at most `limit` in flight at once.
// Resolves to an array of results in input order. A task that throws rejects
// the whole call (callers that want per-item tolerance should catch inside fn).
// On the first rejection the pool ABORTS: surviving workers stop pulling new
// items, all in-flight tasks are awaited (allSettled), and only then does the
// first error rethrow — otherwise workers would keep spawning heavy ffmpeg
// encodes after the caller has already thrown (orphan writes that can corrupt
// the clip cache on hosts whose limit is >1).
async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const cap = Number.isInteger(limit) && limit >= 1 ? limit : 1;
  const results = new Array(list.length);
  let cursor = 0;
  let aborted = false;
  let firstError = null;

  async function worker() {
    while (!aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      try {
        results[index] = await fn(list[index], index);
      } catch (error) {
        if (!aborted) {
          aborted = true;
          firstError = error;
        }
        return;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(cap, list.length); i += 1) workers.push(worker());
  await Promise.allSettled(workers);
  if (aborted) throw firstError;
  return results;
}

module.exports = {
  recommendedHeavyEncodeConcurrency,
  mapWithConcurrency,
};
