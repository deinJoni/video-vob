"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, statePath, storyboardPath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runHyperframesWithRetry, buildLintArgv, LINT_TIMEOUT_MS } = require("../hyperframes-runner.js");
const { stderrTail } = require("../spawn-with-shutdown.js");
const { parseLintReport } = require("../lint-report.js");
const { runCompositionQc } = require("../composition-qc.js");
const { resolveSceneClipLinks, resolveSourceLinks } = require("../source-symlink.js");

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

// Drop hyperframes findings already reported by an equivalent vob finding:
// match on same file+line, or on rule equivalence alone when both findings
// lack a location. Returns { kept, dropped } (dropped = hyperframes findings).
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
  const kept = [];
  const dropped = [];
  for (const h of hfFindings) {
    const candidates = vobByHfRule.get(h.rule);
    const hFile = candidates ? findingFileKey(h) : null;
    const isDuplicate = Boolean(candidates) && candidates.some((v) => {
      const vFile = findingFileKey(v);
      if (vFile !== null && hFile !== null) return vFile === hFile && v.line === h.line;
      // Both lack any location -> the rule equivalence alone matches.
      return vFile === null && hFile === null && v.line == null && h.line == null;
    });
    if (isDuplicate) dropped.push(h);
    else kept.push(h);
  }
  return { kept, dropped };
}

function nowIso() {
  return new Date().toISOString();
}

async function lintComposition(args) {
  const id = assertSafeProjectId(args && args.project_id);
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
  // Fan-out: scope the QC re-run to the short this composition implements
  // (stamped at save time) — otherwise the gate-feeding lint would silently
  // lose scene-coverage/master-duration on a shorts[] storyboard.
  const activeShortId = typeof composition.short_id === "string" && composition.short_id !== ""
    ? composition.short_id
    : null;
  const qc = runCompositionQc({
    files: qcFiles,
    storyboard,
    sourceLinks: resolveSourceLinks(id),
    sceneClipLinks: resolveSceneClipLinks(id),
    checkTargetsOnDisk: true,
    activeShortId,
  });

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
  const findings = [...qc.findings, ...hfFindings]; // vob findings first (more actionable)
  const errorCount = Math.max(0, report.error_count - droppedBySeverity.error) + qc.error_count;
  const warningCount = Math.max(0, report.warning_count - droppedBySeverity.warning) + qc.warning_count;
  const infoCount = Math.max(0, report.info_count - droppedBySeverity.info);
  const lintStatus = errorCount > 0 ? "errors" : warningCount > 0 ? "warnings_only" : "clean";

  const reportPath = path.join(composeRoot, "lint-report.json");
  const reportBody = `${JSON.stringify({
    report_version: 2, // absent = v1 (pre-QC-merge)
    lint_status: lintStatus,
    error_count: errorCount,
    warning_count: warningCount,
    info_count: infoCount,
    findings,
    qc: { error_count: qc.error_count, warning_count: qc.warning_count },
    hyperframes: { error_count: report.error_count, warning_count: report.warning_count, info_count: report.info_count },
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
  description: "Run hyperframes lint plus the engine's static QC over compose/ and merge both into one findings report (compose/lint-report.json; findings carry source:'vob'|'hyperframes'). Sets composition.lint_status — errors block COMPOSE->PREVIEW, warnings are accept-or-fix. Returns merged counts + first 10 findings + report_path.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string" },
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
