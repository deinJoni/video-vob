"use strict";

const os = require("os");
const fs = require("fs");
const path = require("path");
const { spawnSync, execFileSync } = require("child_process");
const { ERROR_CODES, ToolError } = require("./envelope.js");
const { spawnWithShutdown, DEFAULT_MAX_OUTPUT_BYTES } = require("./spawn-with-shutdown.js");

const HYPERFRAMES_INSTALL_HINT =
  "video-vob drives the hyperframes CLI. It resolves the installed `hyperframes` once and runs it under this Node " +
  "(no per-call npx re-resolution). Ensure Node.js 22+ is installed and hyperframes is installed (`npm i -g hyperframes`) " +
  "or reachable via `npx hyperframes`. Set VOB_HYPERFRAMES_BIN to an explicit dist/cli.js to pin a version. " +
  "See https://github.com/heygen-com/hyperframes for details.";

const LINT_TIMEOUT_MS = 60 * 1000;
const RENDER_TIMEOUT_MS = 15 * 60 * 1000;
const FULL_RENDER_TIMEOUT_MS = 30 * 60 * 1000;
const PREFLIGHT_TIMEOUT_MS = 30 * 1000;
const MAX_OUTPUT_BYTES = DEFAULT_MAX_OUTPUT_BYTES;

const RENDER_TIMEOUT_PER_COMPOSITION_SECOND_MS = 20 * 1000;       // preview (draft)
const FULL_RENDER_TIMEOUT_PER_COMPOSITION_SECOND_MS = 40 * 1000;  // full
const RENDER_TIMEOUT_CEILING_MS = 2 * 60 * 60 * 1000;             // preview ceiling 2h
const FULL_RENDER_TIMEOUT_CEILING_MS = 3 * 60 * 60 * 1000;        // full ceiling 3h

// kind: "preview" | "full". durationSeconds: storyboard total or null.
// Env override (positive int ms) wins outright: VOB_RENDER_TIMEOUT_MS (preview),
// VOB_FULL_RENDER_TIMEOUT_MS (full). Otherwise scale by composition duration,
// FLOORED at today's fixed caps (15/30 min) and ceilinged to keep a runaway
// storyboard from creating a day-long wall.
function renderTimeoutMs(kind, durationSeconds) {
  const envName = kind === "full" ? "VOB_FULL_RENDER_TIMEOUT_MS" : "VOB_RENDER_TIMEOUT_MS";
  const env = Number.parseInt((process.env[envName] || "").trim(), 10);
  if (Number.isInteger(env) && env > 0) return env;
  const floor = kind === "full" ? FULL_RENDER_TIMEOUT_MS : RENDER_TIMEOUT_MS;
  const perSec = kind === "full" ? FULL_RENDER_TIMEOUT_PER_COMPOSITION_SECOND_MS : RENDER_TIMEOUT_PER_COMPOSITION_SECOND_MS;
  const ceiling = kind === "full" ? FULL_RENDER_TIMEOUT_CEILING_MS : RENDER_TIMEOUT_CEILING_MS;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return floor;
  return Math.min(ceiling, Math.max(floor, Math.round(durationSeconds * perSec)));
}

// --- Headless-Chrome GPU mode for hyperframes child processes ----------------
//
// hyperframes selects the Chrome GL backend via the PRODUCER_BROWSER_GPU_MODE
// env var ("software" | "hardware" | "auto"; render's CLI default is "auto",
// snapshot/inspect default to "software" internally). In current hyperframes
// (>=0.6.69) "auto" probes WebGL on first launch, races a 2s BeginFrame check,
// and DETERMINISTICALLY falls back to SwiftShader software if the probe fails —
// so the old macOS hang (auto false-positiving on Metal, then hanging in
// BeginFrame calibration) is now self-healed by hyperframes itself. Forcing
// software on darwin is therefore no longer a *correctness* requirement.
//
// We still default darwin to "software" as a PERFORMANCE choice: on a low-RAM
// Apple-Silicon Mac the hardware/Metal capture path is the slow one (it drives
// hyperframes' worker-cost multiplier up and clamps the render to a single
// worker), whereas SwiftShader capture is the steadier, faster path here. On a
// roomier host (16GB+), "auto"/"hardware" is safe and likely faster — flip via
// VOB_BROWSER_GPU.
//
// We set the env var rather than the render-only `--no-browser-gpu` CLI flag
// because the env var governs BOTH `render` AND `snapshot` (and `snapshot`
// rejects that flag), and it expresses all three modes — not just software.
// Applying it centrally here means every hyperframes spawn is covered; no
// individual render/snapshot call site can forget it.
//
// Operators tune this through vob's own VOB_BROWSER_GPU knob (kept distinct
// from the hyperframes-internal env name), resolved to PRODUCER_BROWSER_GPU_MODE:
//   off | software | swiftshader -> "software"  (any OS)
//   on  | hardware | gpu         -> "hardware"  (any OS; re-enables host GPU)
//   auto                         -> "auto"      (any OS; hyperframes probes)
//   unset, PRODUCER_BROWSER_GPU_MODE already exported -> inherit (no override)
//   unset, nothing set           -> darwin: "software"; else inherit
// Returns the mode string to set, or null to leave the child env untouched.
function resolveBrowserGpuMode() {
  const knob = (process.env.VOB_BROWSER_GPU || "").trim().toLowerCase();
  if (knob === "off" || knob === "software" || knob === "swiftshader") return "software";
  if (knob === "on" || knob === "hardware" || knob === "gpu") return "hardware";
  if (knob === "auto") return "auto";
  // No explicit vob knob: defer to a hyperframes-native setting if the operator
  // already exported one; otherwise default software on macOS (faster + steadier
  // on low-RAM Apple Silicon). Leave other platforms on hyperframes' own default.
  if ((process.env.PRODUCER_BROWSER_GPU_MODE || "").trim() !== "") return null;
  return process.platform === "darwin" ? "software" : null;
}

// On a low-RAM Mac the FIRST frame's seek (loading several <video> elements
// into headless Chrome under SwiftShader) can exceed Chrome's 30s default CDP
// protocolTimeout and hyperframes' 45s runtime-readiness window — failing an
// otherwise-progressing render with "Runtime.callFunctionOn timed out" /
// "window.__hf not ready". We raise both generously; our own spawn timeout
// (RENDER_TIMEOUT_MS) still bounds the whole job, and retry-on-timeout is off.
const DEFAULT_PROTOCOL_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_READY_TIMEOUT_MS = 2 * 60 * 1000;

// Child environment for a hyperframes spawn: the resolved GPU mode, a pinned
// (no auto-update/auto-install) engine, and raised Chrome timeouts. Every value
// is applied as a DEFAULT only — an operator who exported the underlying
// PRODUCER_*/HYPERFRAMES_* var wins. This is the single place hyperframes env is
// built, so render/snapshot/lint/transcribe all share one policy.
function hyperframesChildEnv() {
  const env = { ...process.env };

  // GPU backend (see resolveBrowserGpuMode). null => leave hyperframes' default.
  const mode = resolveBrowserGpuMode();
  if (mode !== null) env.PRODUCER_BROWSER_GPU_MODE = mode;

  // Pin the binary: never let a render/snapshot trigger an auto-update or
  // auto-install. hyperframes self-updates on run by default; an upgrade
  // mid-pipeline swaps the engine underneath us (observed 0.6.64 -> 0.6.69
  // within one session, after which BeginFrame capture began timing out). We
  // resolve ONE bin (resolveHyperframesCmd) and freeze its behavior.
  if (!("HYPERFRAMES_NO_UPDATE_CHECK" in process.env)) env.HYPERFRAMES_NO_UPDATE_CHECK = "1";
  if (!("HYPERFRAMES_NO_AUTO_INSTALL" in process.env)) env.HYPERFRAMES_NO_AUTO_INSTALL = "1";

  // Raise Chrome/CDP timeouts (see note above the constants).
  if (!("PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS" in process.env)) {
    env.PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS = String(DEFAULT_PROTOCOL_TIMEOUT_MS);
  }
  if (!("PRODUCER_PLAYER_READY_TIMEOUT_MS" in process.env)) {
    env.PRODUCER_PLAYER_READY_TIMEOUT_MS = String(DEFAULT_READY_TIMEOUT_MS);
  }
  if (!("PRODUCER_RENDER_READY_TIMEOUT_MS" in process.env)) {
    env.PRODUCER_RENDER_READY_TIMEOUT_MS = String(DEFAULT_READY_TIMEOUT_MS);
  }

  // Optional escape hatch: force the screenshot capture path (what `snapshot`
  // uses) instead of BeginFrame, via VOB_FORCE_SCREENSHOT. Off by default —
  // BeginFrame is higher-fidelity and works once the protocol timeout is raised.
  const forceShot = (process.env.VOB_FORCE_SCREENSHOT || "").trim().toLowerCase();
  if (forceShot === "1" || forceShot === "on" || forceShot === "true" || forceShot === "yes") {
    env.PRODUCER_FORCE_SCREENSHOT = "1";
  }

  return env;
}

// Hosts with less than this much total RAM are treated as "low-RAM" and get a
// pinned single render worker by default (see renderWorkerArgs). An 8GB Mac
// (~8.59e9 bytes) qualifies; a 16GB+ host does not.
const LOW_RAM_BYTES = 10 * 1024 * 1024 * 1024;

// Explicit render worker count.
//
// hyperframes auto-calibrates the worker count by timing sample frames whenever
// `--workers` is UNSET *or* set to the literal "auto" (the CLI parser treats
// "auto" as undefined). That calibration is a ~30s/frame BeginFrame probe; on a
// low-RAM/software-GPU Mac it times out, falls back to a screenshot probe that
// also fails, and then clamps the render to 1 worker anyway — having burned the
// whole probe budget first (and, on older hyperframes, aborting the render).
// Passing a POSITIVE INTEGER `--workers` SKIPS calibration entirely.
//
//   VOB_RENDER_WORKERS = <positive int>  -> ["--workers", n]  (skip calibration)
//   VOB_RENDER_WORKERS = "auto"          -> []                (defer to hyperframes)
//   VOB_RENDER_WORKERS unset, low-RAM    -> ["--workers", "1"](skip calibration)
//   VOB_RENDER_WORKERS unset, roomy host -> []                (defer to hyperframes)
function renderWorkerArgs() {
  const raw = (process.env.VOB_RENDER_WORKERS || "").trim().toLowerCase();
  if (raw) {
    if (raw === "auto") return [];
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1) return ["--workers", String(n)];
    return [];
  }
  let totalmem = 0;
  try { totalmem = os.totalmem(); } catch { totalmem = 0; }
  if (totalmem > 0 && totalmem < LOW_RAM_BYTES) return ["--workers", "1"];
  return [];
}

// Final-render quality default, gated like renderWorkerArgs:
//   VOB_RENDER_QUALITY = "high"|"standard" -> that value;  "default" -> null (omit flag)
//   unset: >=10 GB RAM -> "high"; low-RAM host -> null (hyperframes' standard)
function defaultRenderQuality() {
  const raw = (process.env.VOB_RENDER_QUALITY || "").trim().toLowerCase();
  if (raw === "high" || raw === "standard") return raw;
  if (raw === "default") return null;
  let totalmem = 0;
  try { totalmem = os.totalmem(); } catch { totalmem = 0; }
  if (totalmem >= LOW_RAM_BYTES) return "high";
  return null;
}

// --- Single binary resolution ------------------------------------------------
//
// Resolve the hyperframes CLI ONCE per process and invoke it under THIS Node
// (process.execPath), instead of shelling `npx --yes hyperframes` on every call.
// npx re-resolves the package graph each invocation — extra latency, a chance of
// silently floating to a different version than was tested, and (under memory
// pressure) a transient ESM-resolution race that surfaced as
// "Cannot find package '.../node_modules/debug/...' imported from puppeteer-core".
// A human running `hyperframes ...` directly never pays that tax, which is why
// direct runs are reliable where the wrapper flaked. Returns { cmd, baseArgs }.
let _hfCmd = null;
function resolveHyperframesCmd() {
  if (_hfCmd) return _hfCmd;
  const node = process.execPath;

  // 1. Explicit override: a path to dist/cli.js (run under node) or a bin.
  const override = (process.env.VOB_HYPERFRAMES_BIN || "").trim();
  if (override && fs.existsSync(override)) {
    _hfCmd = override.endsWith(".js") ? { cmd: node, baseArgs: [override] } : { cmd: override, baseArgs: [] };
    return _hfCmd;
  }

  // Candidate cli.js paths, in order of preference.
  const candidates = [];
  // 2. The `hyperframes` bin on PATH (the same one a human invokes), realpath'd
  //    to its dist/cli.js so we can run it under our own Node.
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const found = execFileSync(finder, ["hyperframes"], { encoding: "utf8", timeout: 10000 })
      .split(/\r?\n/)[0].trim();
    if (found) candidates.push(found);
  } catch { /* not on PATH; try next */ }
  // 3. The npm global root.
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10000 }).trim();
    if (root) candidates.push(path.join(root, "hyperframes", "dist", "cli.js"));
  } catch { /* npm unavailable; try next */ }

  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (real.endsWith(".js") && fs.existsSync(real)) {
        _hfCmd = { cmd: node, baseArgs: [real] };
        return _hfCmd;
      }
    } catch { /* candidate unreadable; try next */ }
  }

  // 4. Last resort: npx (offline-safe), preserving the original behavior.
  _hfCmd = { cmd: "npx", baseArgs: ["--yes", "hyperframes"] };
  return _hfCmd;
}

// --- Canonical argv builders -------------------------------------------------
// One place that knows how to build each hyperframes invocation, so every call
// site is consistent (no per-tool argv drift, no redundant cwd+positional path).
function buildRenderArgv({ composeRoot, outPath, quality = null }) {
  return [
    "render",
    "--output", outPath,
    ...(quality ? ["--quality", quality] : []),
    ...renderWorkerArgs(),
    composeRoot,
  ];
}

function buildLintArgv({ composeRoot }) {
  return ["lint", "--json", composeRoot];
}

function buildSnapshotArgv({ composeRoot, timecodes = null, frames = null }) {
  // --timeout is bumped from hyperframes' 5000ms default: under memory pressure
  // the runtime can take longer to initialize and a too-tight timeout spuriously
  // fails the snapshot.
  const argv = ["snapshot", "--describe", "false", "--timeout", "10000"];
  if (Array.isArray(timecodes) && timecodes.length > 0) {
    argv.push("--at", timecodes.map((t) => String(t)).join(","));
  } else {
    argv.push("--frames", String(frames));
  }
  argv.push(composeRoot);
  return argv;
}

function buildTranscribeArgv({ inspectDirAbs, audioPath }) {
  return ["transcribe", "--json", "-d", inspectDirAbs, audioPath];
}

function runHyperframesSync(subArgv, { cwd, timeoutMs = LINT_TIMEOUT_MS } = {}) {
  const { cmd, baseArgs } = resolveHyperframesCmd();
  let result;
  try {
    result = spawnSync(
      cmd,
      [...baseArgs, ...subArgv],
      {
        encoding: "utf8",
        cwd,
        env: hyperframesChildEnv(),
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
    );
  } catch (error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes invocation failed: ${error.message || String(error)}. ${HYPERFRAMES_INSTALL_HINT}`,
    );
  }

  if (result.error && result.error.code === "ENOENT") {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes could not be launched (${cmd} not found). ${HYPERFRAMES_INSTALL_HINT}`,
    );
  }
  if (result.error && result.error.code === "ETIMEDOUT") {
    return {
      ok: false,
      timed_out: true,
      exit_code: null,
      signal: result.signal || "SIGTERM",
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }
  if (result.error) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes invocation failed: ${result.error.message || String(result.error)}. ${HYPERFRAMES_INSTALL_HINT}`,
    );
  }

  return {
    ok: result.status === 0,
    timed_out: false,
    exit_code: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function runHyperframesBlocking(subArgv, { cwd, timeoutMs = RENDER_TIMEOUT_MS, stderrLogPath = null, captureStdoutViaFile = false } = {}) {
  const { cmd, baseArgs } = resolveHyperframesCmd();
  return spawnWithShutdown(
    cmd,
    [...baseArgs, ...subArgv],
    {
      cwd,
      env: hyperframesChildEnv(),
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      stderrLogPath,
      captureStdoutViaFile,
      installHint: HYPERFRAMES_INSTALL_HINT,
    },
  );
}

// Errors that are transient/infra and worth retrying: Chrome/CDP death under
// memory pressure, browser launch flakes, and ESM-resolution races. These are
// exactly the failures that "work on a plain re-run" — the gap between our
// wrapper (which surfaced a single flake as a hard error) and a human who just
// re-runs the command.
const RETRYABLE_PATTERNS = [
  /Cannot find package/i,
  /ERR_MODULE_NOT_FOUND/i,
  /imported from .*puppeteer/i,
  /Failed to launch the browser/i,
  /Target closed/i,
  /Connection closed/i,
  /Protocol error/i,
  /Session closed/i,
  /Navigation timeout/i,
  /Waiting failed/i,
  /Runtime\.callFunctionOn timed out/i,
  /HeadlessExperimental\.beginFrame timed out/i,
  /Another frame is pending/i,
  /Page crashed/i,
  /net::ERR/i,
  /spawn\b.*\bEAGAIN/i,
  /\bETIMEDOUT\b/,
  /\bECONNREFUSED\b/,
  /\bEADDRINUSE\b/,
];

// Deterministic CLI aborts: re-running won't change the outcome. Matched first,
// so a transient substring elsewhere in the log can't force a pointless retry.
// (Note: a successful-but-warned render exits 0 and never reaches this check.)
const NON_RETRYABLE_PATTERNS = [
  // Deterministic resource failures: a missing/broken file path in the
  // composition can never succeed on retry. Must out-rank the generic
  // /net::ERR/i transient pattern below.
  /net::ERR_FILE_NOT_FOUND/i,
  /net::ERR_FILE_ACCESS_DENIED/i,
  /net::ERR_INVALID_URL/i,
  /Aborting render/i,
  /Aborting due to/i,
  /strict-variables/i,
  /Invalid workers/i,
  /no compositions? found/i,
  /index\.html.*not found/i,
];

// Wrap runHyperframesBlocking with a bounded retry on transient/infra failures.
// Returns the (structured) result of the last attempt — like runHyperframesBlocking,
// it does NOT throw on non-zero exit; callers keep their own ToolError handling.
//
// opts (beyond the spawn opts cwd/timeoutMs/stderrLogPath/captureStdoutViaFile):
//   maxAttempts   total attempts incl. the first (default 3)
//   backoffMs     per-retry sleep, last value repeated (default [1500, 4000])
//   retryTimedOut whether a timeout should be retried (default false — a long
//                 render that timed out may have been progressing; don't blindly
//                 re-run a 15-30 min job)
//   retryPatterns override the RETRYABLE set (e.g. launch-only for lint)
async function runHyperframesWithRetry(subArgv, opts = {}) {
  const {
    maxAttempts = 3,
    backoffMs = [1500, 4000],
    retryTimedOut = false,
    retryPatterns = RETRYABLE_PATTERNS,
    ...spawnOpts
  } = opts;

  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    last = await runHyperframesBlocking(subArgv, spawnOpts);
    if (last.ok) return last;

    const blob = `${last.stderr || ""}\n${last.stdout || ""}`;
    if (NON_RETRYABLE_PATTERNS.some((re) => re.test(blob))) return last;

    const transient = last.timed_out
      ? retryTimedOut
      : retryPatterns.some((re) => re.test(blob));
    if (!transient || attempt >= maxAttempts) return last;

    const wait = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)];
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return last;
}

function checkHyperframesAvailable({ timeoutMs = PREFLIGHT_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = runHyperframesSync(["--version"], { timeoutMs });
  } catch (error) {
    return { ok: false, version: null, error: error.message || String(error), checked_at: new Date().toISOString() };
  }
  if (result.timed_out) {
    return { ok: false, version: null, error: "preflight timed out", checked_at: new Date().toISOString() };
  }
  if (!result.ok) {
    const stderrPreview = (result.stderr || "").trim().slice(0, 500);
    return {
      ok: false,
      version: null,
      error: stderrPreview || `hyperframes --version exited with status ${result.exit_code}`,
      checked_at: new Date().toISOString(),
    };
  }
  const versionMatch = (result.stdout || "").trim().match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/);
  return {
    ok: true,
    version: versionMatch ? versionMatch[1] : (result.stdout || "").trim().slice(0, 64) || null,
    error: null,
    checked_at: new Date().toISOString(),
  };
}

module.exports = {
  HYPERFRAMES_INSTALL_HINT,
  LINT_TIMEOUT_MS,
  RENDER_TIMEOUT_MS,
  FULL_RENDER_TIMEOUT_MS,
  PREFLIGHT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  checkHyperframesAvailable,
  resolveHyperframesCmd,
  runHyperframesBlocking,
  runHyperframesWithRetry,
  runHyperframesSync,
  resolveBrowserGpuMode,
  hyperframesChildEnv,
  renderWorkerArgs,
  renderTimeoutMs,
  defaultRenderQuality,
  buildRenderArgv,
  buildLintArgv,
  buildSnapshotArgv,
  buildTranscribeArgv,
};
