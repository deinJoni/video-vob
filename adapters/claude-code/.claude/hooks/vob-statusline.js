#!/usr/bin/env node
// video-vob status line: model, cwd, most-recent project + phase, context bar.

const fs = require("fs");
const path = require("path");
const os = require("os");

let input = "";
const timer = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  clearTimeout(timer);
  try {
    const data = input ? JSON.parse(input) : {};
    const model = data.model?.display_name || "Claude";
    const dir = path.basename(data.workspace?.current_dir || process.cwd());

    let session = "";
    const sessRoot = path.join(os.homedir(), "video-vob-sessions");
    try {
      const candidates = fs.readdirSync(sessRoot)
        .map((d) => {
          const f = path.join(sessRoot, d, "state.json");
          try { return { dir: d, mtime: fs.statSync(f).mtimeMs, state: JSON.parse(fs.readFileSync(f, "utf8")) }; }
          catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtime - a.mtime);
      if (candidates.length > 0) {
        const s = candidates[0].state;
        session = ` │ \x1b[1mvob:${s.project_id}@${s.phase}\x1b[0m`;
      }
    } catch {}

    let ctx = "";
    const remaining = data.context_window?.remaining_percentage;
    if (remaining != null) {
      const used = Math.max(0, Math.min(100, Math.round(100 - remaining)));
      const filled = Math.floor(used / 10);
      const bar = "█".repeat(filled) + "░".repeat(10 - filled);
      ctx = ` ${bar} ${used}%`;
    }

    process.stdout.write(`\x1b[2m${model}\x1b[0m │ \x1b[2m${dir}\x1b[0m${session}${ctx}`);
  } catch {}
});
