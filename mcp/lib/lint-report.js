"use strict";

const SEVERITIES = new Set(["error", "warning", "info"]);

function coerceSeverity(raw) {
  if (typeof raw !== "string") return "error";
  const lowered = raw.toLowerCase();
  if (SEVERITIES.has(lowered)) return lowered;
  if (lowered === "err" || lowered === "errors") return "error";
  if (lowered === "warn" || lowered === "warnings") return "warning";
  return "error";
}

function asNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asStringOrNull(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Findings carry `source` ("hyperframes" here; "vob" from composition-qc.js) so
// merged reports stay attributable.
function normalizeFinding(raw, severityOverride) {
  if (!raw || typeof raw !== "object") {
    return {
      severity: severityOverride || "error",
      rule: "(unknown)",
      message: typeof raw === "string" ? raw : "(no message)",
      file: null,
      line: null,
      column: null,
      source: "hyperframes",
    };
  }
  const severity = severityOverride
    ? coerceSeverity(severityOverride)
    : coerceSeverity(raw.severity || raw.level || raw.kind);
  return {
    severity,
    rule: asStringOrNull(raw.rule) || asStringOrNull(raw.ruleId) || asStringOrNull(raw.code) || "(unknown)",
    message: asStringOrNull(raw.message) || asStringOrNull(raw.text) || "(no message)",
    file: asStringOrNull(raw.file) || asStringOrNull(raw.path) || asStringOrNull(raw.filename),
    line: asNumberOrNull(raw.line),
    column: asNumberOrNull(raw.column),
    source: "hyperframes",
  };
}

function collectFindings(parsed) {
  const findings = [];

  if (Array.isArray(parsed.findings)) {
    for (const entry of parsed.findings) {
      findings.push(normalizeFinding(entry));
    }
    return findings;
  }

  if (Array.isArray(parsed.errors)) {
    for (const entry of parsed.errors) findings.push(normalizeFinding(entry, "error"));
  }
  if (Array.isArray(parsed.warnings)) {
    for (const entry of parsed.warnings) findings.push(normalizeFinding(entry, "warning"));
  }
  if (Array.isArray(parsed.info)) {
    for (const entry of parsed.info) findings.push(normalizeFinding(entry, "info"));
  }
  if (Array.isArray(parsed.issues)) {
    for (const entry of parsed.issues) findings.push(normalizeFinding(entry));
  }

  return findings;
}

function parseLintReport(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") {
    return {
      ok: false,
      error_count: 0,
      warning_count: 0,
      info_count: 0,
      findings: [],
      raw: { parse_error: "empty stdout", raw_stdout: stdout || "" },
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return {
      ok: false,
      error_count: 0,
      warning_count: 0,
      info_count: 0,
      findings: [],
      raw: {
        parse_error: error.message || String(error),
        raw_stdout: stdout.slice(0, 2000),
      },
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error_count: 0,
      warning_count: 0,
      info_count: 0,
      findings: [],
      raw: { parse_error: "expected JSON object", raw_stdout: stdout.slice(0, 2000) },
    };
  }

  const findings = collectFindings(parsed);

  let error_count = 0;
  let warning_count = 0;
  let info_count = 0;
  for (const finding of findings) {
    if (finding.severity === "error") error_count += 1;
    else if (finding.severity === "warning") warning_count += 1;
    else if (finding.severity === "info") info_count += 1;
  }

  if (Number.isInteger(parsed.errorCount)) error_count = Math.max(error_count, parsed.errorCount);
  if (Number.isInteger(parsed.warningCount)) warning_count = Math.max(warning_count, parsed.warningCount);
  if (Number.isInteger(parsed.infoCount)) info_count = Math.max(info_count, parsed.infoCount);

  return {
    ok: true,
    error_count,
    warning_count,
    info_count,
    findings,
    raw: parsed,
  };
}

function lintStatusFromReport(report) {
  if (!report || report.ok === false) return "errors";
  if (report.error_count > 0) return "errors";
  if (report.warning_count > 0) return "warnings_only";
  return "clean";
}

module.exports = {
  lintStatusFromReport,
  parseLintReport,
};
