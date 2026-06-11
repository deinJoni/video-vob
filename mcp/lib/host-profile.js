"use strict";

// Host capacity profile — the single resolver for per-machine performance
// constraints, so the same install dir can be tuned up on a big server and down
// on a laptop WITHOUT editing engine source.
//
// Resolution precedence for every setting (first hit wins):
//   1. explicit VOB_* env var   (per-process, e.g. the .mcp.json "env" block)
//   2. host.json per-key field  (e.g. {"render_workers": 6})
//   3. host.json capacity tier  ({"capacity": "high"} expands to a bundle)
//   4. RAM-derived built-in default (the historical behavior — unchanged when
//      no host.json exists, so existing low-RAM installs are byte-for-byte the
//      same as before this module landed)
//
// host.json lives in the install root's .vob-config/ — the same place as
// render-profiles.json — and is read once per process (cached). Absent or
// malformed => built-in defaults, silently (mirrors platform-profiles.js).

const fs = require("fs");
const os = require("os");
const path = require("path");

const GIB = 1024 * 1024 * 1024;
// <10 GB total RAM is the historical "low-RAM" tier (an 8GB Mac, ~8.59e9 B,
// qualifies; a 16GB+ host does not). <20 GB is the mid tier for encode fan-out.
const LOW_RAM_BYTES = 10 * GIB;
const MID_RAM_BYTES = 20 * GIB;

// host-profile.js sits at mcp/lib/, so two ".." reach the install/repo root
// (same anchor render-profiles.json uses in platform-profiles.js).
const OVERRIDE_PATH = path.join(path.resolve(__dirname, "..", ".."), ".vob-config", "host.json");

// A single `capacity` shortcut expands to this bundle; per-key host.json fields
// and any VOB_* env var still override individual values. browser_gpu is
// deliberately NOT tiered — GPU availability is orthogonal to RAM (a 64 GB
// headless server may have no usable GPU), so it stays on its own knob /
// platform default. render_quality null => omit the flag (hyperframes standard).
const CAPACITY_TIERS = Object.freeze({
  low:    Object.freeze({ render_workers: 1, encode_concurrency: 1, render_quality: null,   video_budget: 6,  video_hard_cap: 8 }),
  medium: Object.freeze({ render_workers: 2, encode_concurrency: 2, render_quality: "high", video_budget: 10, video_hard_cap: 12 }),
  high:   Object.freeze({ render_workers: 4, encode_concurrency: 4, render_quality: "high", video_budget: 14, video_hard_cap: 18 }),
});

// Built-in defaults when no capacity tier applies (the un-tunable historical
// values for the video caps; render_workers/quality/encode fall back to the
// RAM-derived functions below instead).
const DEFAULT_VIDEO_BUDGET = 6;
const DEFAULT_VIDEO_HARD_CAP = 8;

let _cache; // undefined = not yet read; otherwise the parsed config object ({} if absent)

function readHostConfig() {
  if (_cache !== undefined) return _cache;
  let parsed = null;
  try {
    const raw = JSON.parse(fs.readFileSync(OVERRIDE_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) parsed = raw;
  } catch {
    parsed = null; // absent/unreadable/malformed -> built-ins (no warning)
  }
  _cache = parsed || {};
  return _cache;
}

// Test seam: force a re-read, optionally with an inline config. Never called by
// the server (the server reads host.json from disk once).
function _reset(configOverride) {
  _cache = configOverride === undefined ? undefined : configOverride || {};
}

function totalRam() {
  try { return os.totalmem(); } catch { return 0; }
}

function capacityTier() {
  const cfg = readHostConfig();
  const c = typeof cfg.capacity === "string" ? cfg.capacity.trim().toLowerCase() : "";
  return CAPACITY_TIERS[c] ? c : null;
}

function tierValue(key) {
  const tier = capacityTier();
  return tier ? CAPACITY_TIERS[tier][key] : undefined;
}

// --- low-level field readers -------------------------------------------------

function envPosInt(name) {
  const raw = (process.env[name] || "").trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

function filePosInt(key) {
  const v = readHostConfig()[key];
  return Number.isInteger(v) && v >= 1 ? v : undefined;
}

// Resolve a positive-int setting through the full precedence chain. Returns
// { value, source } so vob_doctor can show WHERE each value came from.
function resolvePosInt({ envVar, key, ramDefault }) {
  const e = envPosInt(envVar);
  if (e !== undefined) return { value: e, source: "env" };
  const f = filePosInt(key);
  if (f !== undefined) return { value: f, source: "host.json" };
  const t = tierValue(key);
  if (Number.isInteger(t) && t >= 1) return { value: t, source: `capacity:${capacityTier()}` };
  return { value: ramDefault(), source: "ram-default" };
}

// --- per-setting resolvers (each -> { value/..., source }) -------------------

function ramEncodeConcurrency() {
  const m = totalRam();
  if (m <= 0) return 1;
  if (m < LOW_RAM_BYTES) return 1;
  if (m < MID_RAM_BYTES) return 2;
  return 3;
}

function resolveEncodeConcurrency() {
  return resolvePosInt({ envVar: "VOB_ENCODE_CONCURRENCY", key: "encode_concurrency", ramDefault: ramEncodeConcurrency });
}

// render_workers carries an "auto" sentinel (defer to hyperframes calibration)
// in addition to a positive int. Returns { mode: "fixed", n } | { mode: "defer" }.
function resolveRenderWorkers() {
  const raw = (process.env.VOB_RENDER_WORKERS || "").trim().toLowerCase();
  if (raw) {
    if (raw === "auto") return { mode: "defer", source: "env" };
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1) return { mode: "fixed", n, source: "env" };
    return { mode: "defer", source: "env" }; // garbage value -> defer (old behavior)
  }
  const fv = readHostConfig().render_workers;
  if (typeof fv === "string" && fv.trim().toLowerCase() === "auto") return { mode: "defer", source: "host.json" };
  if (Number.isInteger(fv) && fv >= 1) return { mode: "fixed", n: fv, source: "host.json" };
  const tv = tierValue("render_workers");
  if (tv === "auto") return { mode: "defer", source: `capacity:${capacityTier()}` };
  if (Number.isInteger(tv) && tv >= 1) return { mode: "fixed", n: tv, source: `capacity:${capacityTier()}` };
  const m = totalRam();
  if (m > 0 && m < LOW_RAM_BYTES) return { mode: "fixed", n: 1, source: "ram-default" };
  return { mode: "defer", source: "ram-default" };
}

function normQuality(v) {
  if (v === null) return { q: null, ok: true };
  if (typeof v !== "string") return { ok: false };
  const s = v.trim().toLowerCase();
  if (s === "high" || s === "standard") return { q: s, ok: true };
  if (s === "default") return { q: null, ok: true };
  return { ok: false };
}

function resolveRenderQuality() {
  const e = (process.env.VOB_RENDER_QUALITY || "").trim();
  if (e) { const n = normQuality(e); if (n.ok) return { value: n.q, source: "env" }; }
  const cfg = readHostConfig();
  if ("render_quality" in cfg) { const n = normQuality(cfg.render_quality); if (n.ok) return { value: n.q, source: "host.json" }; }
  const tier = capacityTier();
  if (tier) return { value: CAPACITY_TIERS[tier].render_quality, source: `capacity:${tier}` };
  return { value: totalRam() >= LOW_RAM_BYTES ? "high" : null, source: "ram-default" };
}

// Returns the raw GPU knob string ("", "software", "hardware", "auto", ...) for
// hyperframes-runner.js to map to PRODUCER_BROWSER_GPU_MODE (it keeps the darwin
// default + PRODUCER_* inherit policy). env > host.json; no capacity tier.
function resolveBrowserGpuKnob() {
  const e = (process.env.VOB_BROWSER_GPU || "").trim();
  if (e) return { value: e.toLowerCase(), source: "env" };
  const fv = readHostConfig().browser_gpu;
  if (typeof fv === "string" && fv.trim()) return { value: fv.trim().toLowerCase(), source: "host.json" };
  return { value: "", source: "platform-default" };
}

function resolveVideoBudget() {
  return resolvePosInt({ envVar: "VOB_VIDEO_BUDGET", key: "video_budget", ramDefault: () => DEFAULT_VIDEO_BUDGET });
}

function resolveVideoHardCap() {
  return resolvePosInt({ envVar: "VOB_VIDEO_HARD_CAP", key: "video_hard_cap", ramDefault: () => DEFAULT_VIDEO_HARD_CAP });
}

// --- public value getters (used by the consuming modules) --------------------

function encodeConcurrency() { return resolveEncodeConcurrency().value; }
function renderWorkers() { return resolveRenderWorkers(); }            // { mode, n? }
function renderQuality() { return resolveRenderQuality().value; }      // "high"|"standard"|null
function browserGpuKnob() { return resolveBrowserGpuKnob().value; }    // raw knob string
function videoBudget() { return resolveVideoBudget().value; }
// hard cap can never be below the warn budget — a partial override (budget up,
// cap left at default) would otherwise error before it ever warns.
function videoHardCap() { return Math.max(resolveVideoHardCap().value, videoBudget()); }

// --- introspection for vob_doctor -------------------------------------------

function describe() {
  const cfg = readHostConfig();
  const rw = resolveRenderWorkers();
  const gpu = resolveBrowserGpuKnob();
  const q = resolveRenderQuality();
  const enc = resolveEncodeConcurrency();
  const vb = resolveVideoBudget();
  const vhc = resolveVideoHardCap();
  return {
    capacity: capacityTier(),
    config_path: OVERRIDE_PATH,
    config_present: Object.keys(cfg).length > 0,
    total_ram_gib: totalRam() ? Number((totalRam() / GIB).toFixed(2)) : null,
    settings: [
      { setting: "render_workers", value: rw.mode === "fixed" ? rw.n : "auto (hyperframes calibrates)", source: rw.source },
      { setting: "encode_concurrency", value: enc.value, source: enc.source },
      { setting: "render_quality", value: q.value === null ? "(hyperframes standard)" : q.value, source: q.source },
      { setting: "browser_gpu", value: gpu.value || "(platform default)", source: gpu.source },
      { setting: "video_budget", value: vb.value, source: vb.source },
      { setting: "video_hard_cap", value: Math.max(vhc.value, vb.value), source: vhc.source },
    ],
  };
}

module.exports = {
  encodeConcurrency,
  renderWorkers,
  renderQuality,
  browserGpuKnob,
  videoBudget,
  videoHardCap,
  describe,
  CAPACITY_TIERS,
  _reset,
};
