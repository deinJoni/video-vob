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

const os = require("os");

const GIB = 1024 * 1024 * 1024;

// Recommended simultaneous heavy (full-res H.264) encodes for this host.
//   < 10 GB RAM -> 1   (the low-RAM single-worker tier)
//   < 20 GB RAM -> 2
//   else        -> 3
// Override with VOB_ENCODE_CONCURRENCY (positive int).
function recommendedHeavyEncodeConcurrency() {
  const override = Number.parseInt((process.env.VOB_ENCODE_CONCURRENCY || "").trim(), 10);
  if (Number.isInteger(override) && override >= 1) return override;
  let totalmem = 0;
  try { totalmem = os.totalmem(); } catch { totalmem = 0; }
  if (totalmem <= 0) return 1;
  if (totalmem < 10 * GIB) return 1;
  if (totalmem < 20 * GIB) return 2;
  return 3;
}

// Run `fn(item, index)` over `items` with at most `limit` in flight at once.
// Resolves to an array of results in input order. A task that throws rejects
// the whole call (callers that want per-item tolerance should catch inside fn).
async function mapWithConcurrency(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const cap = Number.isInteger(limit) && limit >= 1 ? limit : 1;
  const results = new Array(list.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= list.length) return;
      results[index] = await fn(list[index], index);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(cap, list.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

module.exports = {
  recommendedHeavyEncodeConcurrency,
  mapWithConcurrency,
};
