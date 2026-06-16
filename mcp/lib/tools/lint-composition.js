"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, sessionDir, statePath, storyboardPath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runHyperframesWithRetry, buildLintArgv, LINT_TIMEOUT_MS, runInspect } = require("../hyperframes-runner.js");
const { stderrTail } = require("../spawn-with-shutdown.js");
const { parseLintReport } = require("../lint-report.js");
const { runCompositionQc } = require("../composition-qc.js");
const { resolveLayoutLinks, resolveSceneClipLinks, resolveSourceLinks } = require("../source-symlink.js");
const { planSegmentById } = require("../render-segments.js");
const {
  layoutQcMode,
  shouldRunLayoutQc,
  parseInspectReport,
  mapInspectIssues,
  layoutAdvisory,
} = require("../layout-qc.js");

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
const SOURCE_ORDER = { vob: 0, hyperframes: 1 };

// vob QC rules that deliberately duplicate (pre-empt) hyperframes lint rules —
// without deduping, one defect counts twice in the merged report. Keyed by vob
// rule, valued by the hyperframes rule names that report the same defect
// (enumerated from composition-qc.js: the clip-class pre-empt, the
// Rule-of-Three root attrs, and dead ./source/ media refs).
const VOB_EQUIVALENT_HF_RULES = new Map([
  ["vob/timed_element_missing_clip_class", ["timed_element_missing_clip_class"]],
  ["vob/missing_root_attr", [
    "missing_composition_id",
    "root_missing_composition_id",
    "host_missing_composition_id",
    "missing_composition_dimensions",
    "root_missing_dimensions",
  ]],
  ["vob/unresolved_source_ref", ["audio_src_not_found", "inaccessible_media_url"]],
  ["vob/source_ref_target_missing", ["audio_src_not_found", "inaccessible_media_url"]],
]);

function findingFileKey(finding) {
  // vob findings carry compose-relative paths; hyperframes may report
  // absolute/longer paths — compare basenames.
  return typeof finding.file === "string" && finding.file !== ""
    ? finding.file.split(/[\\/]/).pop()
    : null;
}

// Drop hyperframes findings already reported by an equivalent vob finding.
// hyperframes lint findings carry NO file/line (the CLI emits code + message +
// snippet only), so a located vob finding can never satisfy a file+line match
// against them — the old predicate required one and the dedupe was dead code:
// every pre-empted defect double-counted. Now: a located hyperframes finding
// (future-proofing) still dedupes on same file+line; an unlocated one consumes
// one CREDIT per equivalent vob finding — at most as many hyperframes copies
// are dropped as vob findings exist for that rule, so a hyperframes-only extra
// hit always survives. Returns { kept, dropped } (dropped = hyperframes findings).
function dedupeHyperframesFindings(vobFindings, hfFindings) {
  const vobByHfRule = new Map(); // hyperframes rule -> [vob findings]
  for (const v of vobFindings) {
    const equivalents = VOB_EQUIVALENT_HF_RULES.get(v.rule);
    if (!equivalents) continue;
    for (const hfRule of equivalents) {
      if (!vobByHfRule.has(hfRule)) vobByHfRule.set(hfRule, []);
      vobByHfRule.get(hfRule).push(v);
    }
  }
  if (vobByHfRule.size === 0) return { kept: hfFindings, dropped: [] };
  const credits = new Map(); // hyperframes rule -> unlocated-match credits left
  for (const [rule, list] of vobByHfRule) credits.set(rule, list.length);
  const kept = [];
  const dropped = [];
  for (const h of hfFindings) {
    const candidates = vobByHfRule.get(h.rule);
    if (!candidates) {
      kept.push(h);
      continue;
    }
    const hFile = findingFileKey(h);
    let isDuplicate = false;
    if (hFile !== null && h.line != null) {
      isDuplicate = candidates.some((v) => findingFileKey(v) === hFile && v.line === h.line);
    } else {
      const left = credits.get(h.rule) || 0;
      isDuplicate = left > 0;
      if (isDuplicate) credits.set(h.rule, left - 1);
    }
    if (isDuplicate) dropped.push(h);
    else kept.push(h);
  }
  return { kept, dropped };
}

function nowIso() {
  return new Date().toISOString();
}

// Collect the .html/.css files under a directory (bounded recursive walk) as
// [{relPath, content}] for the static QC pass.
function collectHtmlCssFiles(root) {
  const out = [];
  const MAX = 200;
  const walk = (dir, rel) => {
    if (out.length >= MAX) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= MAX) return;
      const childAbs = path.join(dir, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      // Skip the injected asset dirs (fonts/captions kits) and any source media.
      if (ent.isDirectory()) {
        if (ent.name === "fonts" || ent.name === "captions" || ent.name === "source" || ent.name === "node_modules") continue;
        walk(childAbs, childRel);
      } else if (/\.(html|css)$/i.test(ent.name)) {
        try {
          out.push({ relPath: childRel, content: fs.readFileSync(childAbs, "utf8") });
        } catch { /* unreadable; skip */ }
      }
    }
  };
  walk(root, "");
  return out;
}

// Off-rails QC (escape hatch, v3.4): lint an ARBITRARY composition directory
// (e.g. a bespoke hyperframes build under <session>/work/) with the SAME engine
// QC the on-rails path uses — most importantly the caption font-size floor and,
// via hyperframes inspect, layout/legibility (text/safe-band overflow). This is
// the equivalent of lint/QC for escape-hatch work, which previously had none
// (the reason a tester's off-rails short shipped 52px captions under the floor).
// It does NOT require (or touch) the saved-composition FSM state: storyboard-
// dependent checks are skipped (storyboard:null), and the report is written into
// the work dir itself. compose_dir must resolve inside the session (the report
// write + the sanctioned work/ scratch subtree).
async function lintArbitraryDir(id, composeDirArg) {
  // Containment: compose_dir must be the sanctioned escape-hatch scratch subtree
  // <session>/work/ (where both write-guards already allow writes), and the check
  // is symlink-SAFE — realpath both sides so a symlink planted under work/ that
  // points outside the session can't smuggle the lint-report.json write out.
  let sessionRoot;
  try {
    sessionRoot = fs.realpathSync(path.resolve(sessionDir(id)));
  } catch {
    sessionRoot = path.resolve(sessionDir(id));
  }
  const workRoot = path.join(sessionRoot, "work");
  let root;
  try {
    root = fs.realpathSync(path.resolve(composeDirArg));
  } catch {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `compose_dir does not exist: ${composeDirArg} — point it at a hyperframes composition directory under <session>/work/`,
    );
  }
  const within = root === workRoot || root.startsWith(workRoot + path.sep);
  if (!within) {
    throw new ToolError(
      ERROR_CODES.INVALID_ARGUMENTS,
      `compose_dir must be inside the escape-hatch scratch dir ${workRoot} — bespoke off-rails work lives under <session>/work/. Got: ${root}`,
    );
  }
  const indexPath = path.join(root, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `no index.html in compose_dir ${root} — point compose_dir at a hyperframes composition directory`,
    );
  }

  const result = await runHyperframesWithRetry(buildLintArgv({ composeRoot: root }), {
    timeoutMs: LINT_TIMEOUT_MS,
    captureStdoutViaFile: true,
    maxAttempts: 2,
    retryPatterns: [/Cannot find package/i, /ERR_MODULE_NOT_FOUND/i, /imported from .*puppeteer/i],
  });
  if (result.timed_out) {
    throw new ToolError(ERROR_CODES.INTERNAL_ERROR, `hyperframes lint timed out after ${Math.round(LINT_TIMEOUT_MS / 1000)}s`);
  }
  const report = parseLintReport(result.stdout);
  if (!report.ok) {
    const parseError = (report.raw && report.raw.parse_error) || "unknown parse error";
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes lint output was not parseable for ${root} (exit ${result.exit_code}): ${parseError}`,
      { exit_code: result.exit_code, stderr_preview: stderrTail(result.stderr, 800) },
    );
  }

  // Static QC with NO storyboard: the storyboard-dependent checks (scene
  // coverage, source-ref resolution, overlay/caption binding) are skipped, but
  // the caption font-size floor + <video> budget + absolute-path checks all run
  // off the composition itself — exactly what off-rails work needs.
  const qcFiles = collectHtmlCssFiles(root);
  const qc = runCompositionQc({
    files: qcFiles,
    storyboard: null,
    sourceLinks: [],
    sceneClipLinks: [],
    layoutLinks: [],
    checkTargetsOnDisk: false,
  });

  // Layout / legibility QC (safe bands, overflow) via hyperframes inspect. The
  // on-rails path gates this on the storyboard carrying captions/overlays; off
  // rails we have no storyboard, so run it whenever layout QC is not disabled —
  // safe bands are the whole point of the escape-hatch QC ask. Non-fatal.
  let inspectFindings = [];
  let inspectMeta = { ran: false, skipped_reason: "disabled" };
  if (layoutQcMode() !== "off") {
    try {
      const ins = await runInspect({ composeRoot: root });
      if (ins.timed_out) {
        inspectFindings = [layoutAdvisory("vob/layout_qc_skipped", "hyperframes inspect timed out — caption/layout legibility not verified")];
        inspectMeta = { ran: false, skipped_reason: "timeout" };
      } else {
        const inspectReport = parseInspectReport(ins.stdout);
        if (!inspectReport.ok) {
          inspectFindings = [layoutAdvisory("vob/layout_qc_skipped", `hyperframes inspect output not parseable (${inspectReport.parse_error || "unknown"})`)];
          inspectMeta = { ran: false, skipped_reason: "unparseable" };
        } else {
          inspectFindings = mapInspectIssues(inspectReport, { storyboard: null, activeShortId: null, activeSegment: null });
          inspectMeta = { ran: true, samples: inspectReport.sample_count, issue_count: inspectReport.issue_count };
        }
      }
    } catch (err) {
      inspectFindings = [layoutAdvisory("vob/layout_qc_skipped", `layout QC did not run — ${err && err.message ? err.message : String(err)}`)];
      inspectMeta = { ran: false, skipped_reason: "error" };
    }
  }

  const { kept: hfFindings, dropped: hfDropped } = dedupeHyperframesFindings(qc.findings, report.findings);
  const droppedBySeverity = { error: 0, warning: 0, info: 0 };
  for (const f of hfDropped) if (f.severity in droppedBySeverity) droppedBySeverity[f.severity] += 1;
  let inspectWarnings = 0;
  let inspectInfo = 0;
  for (const f of inspectFindings) {
    if (f.severity === "warning") inspectWarnings += 1;
    else if (f.severity === "info") inspectInfo += 1;
  }
  const findings = [...qc.findings, ...inspectFindings, ...hfFindings];
  const errorCount = Math.max(0, report.error_count - droppedBySeverity.error) + qc.error_count;
  const warningCount = Math.max(0, report.warning_count - droppedBySeverity.warning) + qc.warning_count + inspectWarnings;
  const infoCount = Math.max(0, report.info_count - droppedBySeverity.info) + inspectInfo;
  const lintStatus = errorCount > 0 ? "errors" : warningCount > 0 ? "warnings_only" : "clean";

  const reportPath = path.join(root, "lint-report.json");
  writeFileAtomic(reportPath, `${JSON.stringify({
    report_version: 3,
    off_rails: true,
    compose_dir: root,
    lint_status: lintStatus,
    error_count: errorCount,
    warning_count: warningCount,
    info_count: infoCount,
    findings,
    qc: { error_count: qc.error_count, warning_count: qc.warning_count },
    hyperframes: { error_count: report.error_count, warning_count: report.warning_count, info_count: report.info_count },
    inspect: inspectMeta,
    ran_at: nowIso(),
  }, null, 2)}\n`);

  const findingsSummary = findings
    .slice()
    .sort((a, b) => {
      const sev = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
      if (sev !== 0) return sev;
      return (SOURCE_ORDER[a.source] ?? 2) - (SOURCE_ORDER[b.source] ?? 2);
    })
    .slice(0, 10);

  return {
    off_rails: true,
    compose_dir: root,
    lint_status: lintStatus,
    error_count: errorCount,
    warning_count: warningCount,
    info_count: infoCount,
    qc_error_count: qc.error_count,
    qc_warning_count: qc.warning_count,
    findings_summary: findingsSummary,
    report_path: reportPath,
  };
}

async function lintComposition(args) {
  const id = assertSafeProjectId(args && args.project_id);
  // Off-rails escape-hatch QC: lint an arbitrary work/ composition dir with the
  // same QC (caption floor + layout/safe-band inspect) and no FSM coupling.
  if (args && typeof args.compose_dir === "string" && args.compose_dir.trim() !== "") {
    return lintArbitraryDir(id, args.compose_dir.trim());
  }
  const composeRoot = composeDir(id);

  // Read state outside the lock — the lint binary takes seconds; do its work
  // first, then lock briefly to commit state and report.
  const state = readSessionStateStrict(id);
  const composition = state.composition && typeof state.composition === "object" && !Array.isArray(state.composition)
    ? state.composition
    : null;
  if (!composition || !Array.isArray(composition.files) || composition.files.length === 0) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      "no composition saved — invoke the composer subagent and call vob_save_composition before linting",
    );
  }
  // Revision binding: this lint run validates THESE files. If a save lands
  // while the lint binary runs, the commit below must not stamp the old
  // verdict onto the new revision.
  const lintedRevision = Number.isInteger(composition.revision_count) ? composition.revision_count : 0;
  const indexPath = path.join(composeRoot, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new ToolError(
      ERROR_CODES.NOT_FOUND,
      `composition files missing from disk (expected ${indexPath}) — re-save the composition`,
    );
  }

  // Stream lint output via the async runner (spawnWithShutdown). The sync path
  // (spawnSync) truncated hyperframes' `--json` stdout at 8192 bytes on child
  // exit, corrupting any lint report past ~15 findings and making the COMPOSE
  // self-heal loop unreachable. The streaming reader captures the full report
  // up to MAX_OUTPUT_BYTES (4 MiB).
  const result = await runHyperframesWithRetry(buildLintArgv({ composeRoot }), {
    timeoutMs: LINT_TIMEOUT_MS,
    captureStdoutViaFile: true,
    maxAttempts: 2,
    // lint is pure-Node (no Chrome): the only transient worth retrying is an ESM
    // module-resolution flake at launch. A found-errors report (exit 1 + valid
    // JSON) must NEVER be retried — its content won't match these launch patterns.
    retryPatterns: [/Cannot find package/i, /ERR_MODULE_NOT_FOUND/i, /imported from .*puppeteer/i],
  });

  if (result.timed_out) {
    throw new ToolError(
      ERROR_CODES.INTERNAL_ERROR,
      `hyperframes lint timed out after ${Math.round(LINT_TIMEOUT_MS / 1000)}s`,
    );
  }

  const report = parseLintReport(result.stdout);
  if (!report.ok) {
    // Could not parse the lint output. A non-zero exit is NOT itself a crash —
    // `lint` exits 1 when it FINDS errors and still emits valid JSON we parse
    // happily above. The real failure is *unparseable* output: either a genuine
    // CLI crash (no stdout) or a malformed/truncated payload. Classify the two
    // distinctly so the orchestrator gets an actionable error instead of a
    // misleading "lint failed (exit 1)".
    const stdoutBytes = (result.stdout || "").length;
    const stderrPreview = stderrTail(result.stderr, 1000) || "";
    const parseError = (report.raw && report.raw.parse_error) || "unknown parse error";
    const looksTruncated = result.stdout_truncated === true
      || /unterminated|unexpected end/i.test(String(parseError));
    const message = stdoutBytes === 0
      ? `hyperframes lint produced no parseable output (exit ${result.exit_code}) — likely a CLI crash: ${stderrPreview || "no stderr"}`
      : looksTruncated
        ? `hyperframes lint output was truncated/malformed at ${stdoutBytes} bytes (stdout_truncated=${result.stdout_truncated === true}): ${parseError}`
        : `hyperframes lint output was not valid JSON (exit ${result.exit_code}, ${stdoutBytes} bytes): ${parseError}. stderr: ${stderrPreview || "none"}`;
    throw new ToolError(ERROR_CODES.INTERNAL_ERROR, message, {
      exit_code: result.exit_code,
      stdout_bytes: stdoutBytes,
      stdout_truncated: result.stdout_truncated === true,
      parse_error: parseError,
      stderr_preview: stderrPreview,
    });
  }

  // Re-run static QC against DISK truth and merge with the hyperframes report:
  // clips deleted since save, a storyboard changed via PLAN back-edge without a
  // re-save, or a legacy pre-v2 save all surface here. The overlay-mode
  // exemption lives inside runCompositionQc, so it applies identically at save
  // and lint time.
  const compositionFiles = composition.files.filter((rel) => /\.(html|css)$/i.test(rel));
  const qcFiles = [];
  for (const rel of compositionFiles) {
    try {
      qcFiles.push({ relPath: rel, content: fs.readFileSync(path.join(composeRoot, rel), "utf8") });
    } catch {}
  }
  let storyboard = null;
  try {
    storyboard = JSON.parse(fs.readFileSync(storyboardPath(id), "utf8"));
  } catch {
    storyboard = null;
  }
  if (storyboard && (typeof storyboard !== "object" || Array.isArray(storyboard))) storyboard = null;
  // Fan-out / segmented render: scope the QC re-run to the short or render
  // segment this composition implements (stamped at save time) — otherwise
  // the gate-feeding lint would silently lose scene-coverage/master-duration
  // on a shorts[] storyboard or a chunked long-form plan.
  const activeShortId = typeof composition.short_id === "string" && composition.short_id !== ""
    ? composition.short_id
    : null;
  const stampedSegmentId = typeof composition.segment_id === "string" && composition.segment_id !== ""
    ? composition.segment_id
    : null;
  const planSegment = stampedSegmentId ? planSegmentById(state, stampedSegmentId) : null;
  const activeSegment = planSegment
    ? { segment_id: planSegment.segment_id, scene_ids: planSegment.scene_ids }
    : (stampedSegmentId ? { segment_id: stampedSegmentId, scene_ids: [] } : null); // unresolved -> QC warns
  const qc = runCompositionQc({
    files: qcFiles,
    storyboard,
    sourceLinks: resolveSourceLinks(id),
    sceneClipLinks: resolveSceneClipLinks(id),
    layoutLinks: resolveLayoutLinks(id),
    checkTargetsOnDisk: true,
    activeShortId,
    activeSegment,
  });

  // Layout / legibility QC (v3.3): render a few sample frames via `hyperframes
  // inspect` and fold text/container/canvas overflow into the findings as
  // ADVISORY findings (warnings for box overflow, info for off-canvas) — never
  // errors, so the COMPOSE->PREVIEW gate (errors only) is unchanged. Gated to
  // scopes that actually carry captions/typed overlays (nothing geometric to
  // measure otherwise) unless VOB_LAYOUT_QC forces it; fully non-fatal — a
  // timeout/crash/unparse degrades to one advisory note and the lint stands.
  let inspectFindings = [];
  let inspectMeta = { ran: false, skipped_reason: "no_captions_or_overlays" };
  const layoutMode = layoutQcMode();
  if (layoutMode === "off") {
    inspectMeta = { ran: false, skipped_reason: "disabled" };
  } else if (layoutMode === "always" || shouldRunLayoutQc(storyboard, { activeShortId, activeSegment })) {
    try {
      const ins = await runInspect({ composeRoot });
      if (ins.timed_out) {
        inspectFindings = [layoutAdvisory("vob/layout_qc_skipped", "hyperframes inspect timed out — caption/overlay legibility not verified this run")];
        inspectMeta = { ran: false, skipped_reason: "timeout" };
      } else {
        const inspectReport = parseInspectReport(ins.stdout);
        if (!inspectReport.ok) {
          inspectFindings = [layoutAdvisory("vob/layout_qc_skipped", `hyperframes inspect output not parseable — legibility not verified (${inspectReport.parse_error || "unknown"})`)];
          inspectMeta = { ran: false, skipped_reason: "unparseable" };
        } else {
          inspectFindings = mapInspectIssues(inspectReport, { storyboard, activeShortId, activeSegment });
          inspectMeta = { ran: true, samples: inspectReport.sample_count, issue_count: inspectReport.issue_count };
        }
      }
    } catch (err) {
      inspectFindings = [layoutAdvisory("vob/layout_qc_skipped", `layout QC did not run — ${err && err.message ? err.message : String(err)}`)];
      inspectMeta = { ran: false, skipped_reason: "error" };
    }
  }

  // Dedupe: vob QC deliberately pre-empts a few hyperframes rules — drop the
  // hyperframes copy of any defect an equivalent vob finding already reports,
  // then recompute counts from the deduped list (subtracting the dropped
  // findings from the hyperframes counts preserves parseLintReport's
  // count-vs-findings max semantics).
  const { kept: hfFindings, dropped: hfDropped } = dedupeHyperframesFindings(qc.findings, report.findings);
  const droppedBySeverity = { error: 0, warning: 0, info: 0 };
  for (const f of hfDropped) {
    if (f.severity in droppedBySeverity) droppedBySeverity[f.severity] += 1;
  }
  // vob QC findings first (most actionable), then the advisory inspect overflow
  // findings, then the (deduped) hyperframes findings.
  const findings = [...qc.findings, ...inspectFindings, ...hfFindings];
  let inspectWarnings = 0;
  let inspectInfo = 0;
  for (const f of inspectFindings) {
    if (f.severity === "warning") inspectWarnings += 1;
    else if (f.severity === "info") inspectInfo += 1;
  }
  const errorCount = Math.max(0, report.error_count - droppedBySeverity.error) + qc.error_count;
  const warningCount = Math.max(0, report.warning_count - droppedBySeverity.warning) + qc.warning_count + inspectWarnings;
  const infoCount = Math.max(0, report.info_count - droppedBySeverity.info) + inspectInfo;
  const lintStatus = errorCount > 0 ? "errors" : warningCount > 0 ? "warnings_only" : "clean";

  const reportPath = path.join(composeRoot, "lint-report.json");
  const reportBody = `${JSON.stringify({
    report_version: 3, // 3 = + layout/legibility inspect fold-in; 2 = QC-merge; absent = v1
    lint_status: lintStatus,
    error_count: errorCount,
    warning_count: warningCount,
    info_count: infoCount,
    findings,
    qc: { error_count: qc.error_count, warning_count: qc.warning_count },
    hyperframes: { error_count: report.error_count, warning_count: report.warning_count, info_count: report.info_count },
    inspect: inspectMeta, // { ran, samples?, issue_count? } | { ran:false, skipped_reason }
    deduped_hyperframes_findings: hfDropped.length,
    raw: report.raw,
    exit_code: result.exit_code,
    stderr_preview: stderrTail(result.stderr, 1000),
    ran_at: nowIso(),
  }, null, 2)}\n`;

  return withSessionLock(id, () => {
    const stateNow = readSessionStateStrict(id);
    const compositionNow = stateNow.composition && typeof stateNow.composition === "object" && !Array.isArray(stateNow.composition)
      ? stateNow.composition
      : null;
    if (!compositionNow) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        "composition disappeared from state between read and lint commit — re-save the composition",
      );
    }
    const revisionNow = Number.isInteger(compositionNow.revision_count) ? compositionNow.revision_count : 0;
    if (revisionNow !== lintedRevision) {
      throw new ToolError(
        ERROR_CODES.STATE_CONFLICT,
        "composition was re-saved during lint — re-run vob_lint_composition",
        { linted_revision: lintedRevision, current_revision: revisionNow },
      );
    }

    writeFileAtomic(reportPath, reportBody);

    const ts = nowIso();
    const next = {
      ...stateNow,
      composition: {
        ...compositionNow,
        lint_status: lintStatus,
        lint_report_path: reportPath,
        lint_ran_at: ts,
      },
      last_updated: ts,
      history: [
        ...(Array.isArray(stateNow.history) ? stateNow.history : []),
        {
          kind: "lint_ran",
          at: ts,
          lint_status: lintStatus,
          error_count: errorCount,
          warning_count: warningCount,
          info_count: infoCount,
          qc_error_count: qc.error_count,
          qc_warning_count: qc.warning_count,
          report_path: reportPath,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    // D1 inline cap: errors first, then warnings, then info; vob before
    // hyperframes within a class; first 10 only (full list at report_path).
    const findingsSummary = findings
      .slice()
      .sort((a, b) => {
        const sev = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
        if (sev !== 0) return sev;
        return (SOURCE_ORDER[a.source] ?? 2) - (SOURCE_ORDER[b.source] ?? 2);
      })
      .slice(0, 10);

    return {
      lint_status: lintStatus,
      error_count: errorCount,
      warning_count: warningCount,
      info_count: infoCount,
      qc_error_count: qc.error_count,
      qc_warning_count: qc.warning_count,
      findings_summary: findingsSummary,
      report_path: reportPath,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_lint_composition",
  description: "Run hyperframes lint plus the engine's static QC over compose/ and merge both into one findings report (compose/lint-report.json; findings carry source:'vob'|'hyperframes'). Sets composition.lint_status — errors block COMPOSE->PREVIEW, warnings are accept-or-fix. Returns merged counts + first 10 findings + report_path. OPTIONAL compose_dir: lint an ARBITRARY hyperframes composition directory (must be under the escape-hatch scratch dir <session>/work/) WITHOUT touching FSM state — gives off-rails work the same QC (the caption font-size floor + hyperframes-inspect layout/safe-band overflow); the report is written into that dir and {off_rails:true} is returned.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
      compose_dir: { type: "string", description: "Optional: lint this composition directory (must be under <session>/work/) instead of compose/. Off-rails escape-hatch QC — no FSM state is read or written." },
    },
    required: ["project_id"],
  },
  handler: lintComposition,
  role_bundles: ["orchestrator"],
  mutating: true,
  global_preapproval: false,
  network_access: true,
  browser_access: false,
  scope_required: false,
  sensitive_output: false,
  session_artifacts_written: ["compose/lint-report.json", "state.json"],
  hook_required: false,
});
