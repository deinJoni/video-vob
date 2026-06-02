"use strict";

const fs = require("fs");
const path = require("path");

const { ERROR_CODES, ToolError } = require("../envelope.js");
const { assertSafeProjectId, composeDir, statePath } = require("../paths.js");
const { withSessionLock, writeFileAtomic } = require("../storage.js");
const { readSessionStateStrict } = require("../session-state.js");
const { runHyperframesWithRetry, buildLintArgv, LINT_TIMEOUT_MS } = require("../hyperframes-runner.js");
const { lintStatusFromReport, parseLintReport } = require("../lint-report.js");

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
    const stderrPreview = (result.stderr || "").trim().slice(0, 1000);
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

  const lintStatus = lintStatusFromReport(report);
  const reportPath = path.join(composeRoot, "lint-report.json");
  const reportBody = `${JSON.stringify({
    lint_status: lintStatus,
    error_count: report.error_count,
    warning_count: report.warning_count,
    info_count: report.info_count,
    findings: report.findings,
    raw: report.raw,
    exit_code: result.exit_code,
    stderr_preview: (result.stderr || "").trim().slice(0, 1000) || null,
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
          error_count: report.error_count,
          warning_count: report.warning_count,
          info_count: report.info_count,
          report_path: reportPath,
        },
      ],
    };
    writeFileAtomic(statePath(id), `${JSON.stringify(next, null, 2)}\n`);

    return {
      lint_status: lintStatus,
      error_count: report.error_count,
      warning_count: report.warning_count,
      info_count: report.info_count,
      findings_summary: report.findings.slice(0, 20),
      report_path: reportPath,
    };
  });
}

module.exports = Object.freeze({
  name: "vob_lint_composition",
  description: "Run `hyperframes lint --json` against the session's compose/ directory, parse the result, and write a structured lint-report.json. Updates state.composition with lint_status ('clean', 'warnings_only', or 'errors'), lint_report_path, and lint_ran_at, and appends a 'lint_ran' event to history. Errors block the COMPOSE -> PREVIEW gate; warnings_only passes the gate but the orchestrator should surface findings to the user for accept-or-fix. The full normalized findings list is on disk at the returned report_path; the tool response includes only the first 20 findings.",
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
