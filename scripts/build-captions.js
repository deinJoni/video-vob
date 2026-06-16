"use strict";

// build-captions.js — (re)build the vendored caption-component kit under
// mcp/assets/captions/.
//
// Mirrors scripts/build-fonts.js: a manifest of components, materialized at
// BUILD time from the hyperframes registry (`hyperframes add <name>`), vendored
// + committed so RUN time is fully offline. The script is the SOURCE OF TRUTH;
// the assets are committed. Re-run to refresh to the installed hyperframes:
//
//   node scripts/build-captions.js               # add every component + write manifest
//   node scripts/build-captions.js --manifest-only  # regenerate manifest/README/LICENSES only
//
// What it vendors: each of hyperframes' ~15 vetted, lint-clean caption
// components as a self-contained REFERENCE composition under
// mcp/assets/captions/<name>/<name>.html (+ any sibling assets the component
// ships, e.g. caption-texture's texture PNGs). These are REFERENCE
// implementations the composer ADAPTS from (it re-chunks/re-times and swaps in
// the vendored font kit) — see the generated README.md for the required
// adaptations. The manifest maps the caption `animation` enum
// (pop|word-by-word|karaoke) -> a canonical component, plus per-component
// metadata (word-level? consumes a transcript? which font, is it in the kit?).
//
// Node >= 22. Zero npm deps. Shells the installed `hyperframes` CLI at build
// time only (dev tooling — the engine's one-runner policy governs RUN time).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CAPTIONS_DIR = path.resolve(__dirname, "..", "mcp", "assets", "captions");
const FONTS_CSS = path.resolve(__dirname, "..", "mcp", "assets", "fonts.css");

// animation enum -> canonical component. `default` is what the composer reaches
// for; `alternates` are vetted swaps for the same animation class.
const ANIMATIONS = {
  pop: {
    default: "caption-highlight",
    alternates: ["caption-editorial-emphasis", "caption-gradient-fill", "caption-neon-glow", "caption-clip-wipe", "caption-matrix-decode", "caption-particle-burst", "caption-parallax-layers", "caption-texture"],
  },
  "word-by-word": {
    default: "caption-kinetic-slam",
    alternates: ["caption-weight-shift", "caption-neon-accent", "caption-glitch-rgb", "caption-emoji-pop"],
  },
  karaoke: {
    default: "caption-pill-karaoke",
    alternates: [],
  },
};

// Per-component editorial metadata. `suited_for` drives word_level (anything
// realizing word-by-word/karaoke is word-level). Everything else (font, external
// deps, transcript consumption, file list, bytes) is DETECTED from the
// materialized file so the manifest can't drift from what's on disk.
const COMPONENTS = [
  { name: "caption-pill-karaoke", suited_for: ["karaoke"], note: "Rounded pill; per-word karaoke highlight driven by an inline [{text,start,end}] transcript, with a hard tl.set() kill at exit." },
  { name: "caption-kinetic-slam", suited_for: ["word-by-word"], note: "Words slam in one at a time with a kinetic scale/impact — the word-by-word default." },
  { name: "caption-weight-shift", suited_for: ["word-by-word"], note: "Per-word weight shift as each word becomes active (variable-weight typography)." },
  { name: "caption-neon-accent", suited_for: ["word-by-word"], note: "Per-word neon accent reveal." },
  { name: "caption-glitch-rgb", suited_for: ["word-by-word"], note: "Per-word RGB-split glitch reveal." },
  { name: "caption-emoji-pop", suited_for: ["word-by-word", "pop"], note: "Per-word reveal with emoji pops on keywords (mind the SwiftShader large-emoji artifact — keep emoji small)." },
  { name: "caption-highlight", suited_for: ["pop"], note: "Clean chunk caption with a sweeping highlight bar behind the active line — the pop default." },
  { name: "caption-editorial-emphasis", suited_for: ["pop"], note: "Editorial chunk caption; emphasis words get a distinct weight/color treatment (good for emphasis_words[])." },
  { name: "caption-gradient-fill", suited_for: ["pop"], note: "Chunk caption with an animated gradient text fill." },
  { name: "caption-neon-glow", suited_for: ["pop"], note: "Chunk caption with a neon glow/bloom." },
  { name: "caption-clip-wipe", suited_for: ["pop"], note: "Chunk caption revealed by a clip-path wipe." },
  { name: "caption-matrix-decode", suited_for: ["pop"], note: "Chunk caption that scrambles/decodes into place." },
  { name: "caption-particle-burst", suited_for: ["pop"], note: "Chunk caption with a particle burst on entry." },
  { name: "caption-parallax-layers", suited_for: ["pop"], note: "Layered parallax chunk caption." },
  { name: "caption-texture", suited_for: ["pop"], note: "Chunk caption with a textured material fill — ships sample texture PNGs as siblings." },
];

function hyperframesVersion() {
  try {
    const out = execFileSync("hyperframes", ["--version"], { encoding: "utf8", timeout: 20000 }).trim();
    const m = out.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/);
    return m ? m[1] : out.slice(0, 32);
  } catch {
    return "unknown";
  }
}

// Materialize one component into CAPTIONS_DIR/<name>/ via `hyperframes add`.
function materializeComponent(name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vob-cap-"));
  try {
    const out = execFileSync(
      "hyperframes",
      ["add", name, "--dir", tmp, "--json", "--no-clipboard"],
      { encoding: "utf8", timeout: 120000 },
    );
    const parsed = JSON.parse(out);
    if (!parsed.ok || !Array.isArray(parsed.written) || parsed.written.length === 0) {
      throw new Error(`add returned no files: ${out.slice(0, 200)}`);
    }
    const destDir = path.join(CAPTIONS_DIR, name);
    fs.mkdirSync(destDir, { recursive: true });
    const files = [];
    for (const src of parsed.written) {
      if (!fs.existsSync(src)) continue;
      const base = path.basename(src);
      fs.copyFileSync(src, path.join(destDir, base));
      files.push(base);
    }
    if (!files.includes(`${name}.html`)) {
      throw new Error(`${name}: expected ${name}.html among written files (${files.join(", ")})`);
    }
    return files.sort();
  } finally {
    // Always reap the scratch dir — even when `hyperframes add` throws (exit 1),
    // the copy loop fails, or the html-missing guard fires.
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- on-disk metadata detection ----------------------------------------------
function kitFamilies() {
  // The render-time font set: every @font-face family in the committed fonts.css.
  const set = new Set();
  try {
    const css = fs.readFileSync(FONTS_CSS, "utf8");
    const re = /font-family:\s*"([^"]+)"/gi;
    let m;
    while ((m = re.exec(css)) !== null) set.add(m[1].trim().toLowerCase());
  } catch { /* no kit -> empty set */ }
  return set;
}

function detectFontFamily(html) {
  // The intended display face: the Google-Fonts `family=` param is the clearest
  // signal; fall back to the first CSS font-family token.
  const gf = html.match(/fonts\.googleapis\.com\/css2\?family=([^:&"'\\]+)/i);
  if (gf) return decodeURIComponent(gf[1].replace(/\+/g, " ")).trim();
  const css = html.match(/font-family:\s*["']?([A-Za-z0-9 _-]+)["']?/i);
  return css ? css[1].trim() : null;
}

function detectMeta(name, files) {
  const htmlPath = path.join(CAPTIONS_DIR, name, `${name}.html`);
  const html = fs.readFileSync(htmlPath, "utf8");
  let bytes = 0;
  for (const f of files) {
    try { bytes += fs.statSync(path.join(CAPTIONS_DIR, name, f)).size; } catch {}
  }
  return {
    font_family: detectFontFamily(html),
    has_google_fonts_link: /fonts\.googleapis\.com/i.test(html),
    has_gsap: /\bgsap\b/i.test(html),
    consumes_transcript: /\bTRANSCRIPT\b/.test(html),
    bytes,
  };
}

function buildManifest(version) {
  const kit = kitFamilies();
  const components = {};
  for (const c of COMPONENTS) {
    const dir = path.join(CAPTIONS_DIR, c.name);
    if (!fs.existsSync(dir)) {
      throw new Error(`component dir missing: ${dir} — run \`node scripts/build-captions.js\` (no --manifest-only) first`);
    }
    const files = fs.readdirSync(dir).filter((f) => f !== "SPEC.md").sort();
    const meta = detectMeta(c.name, files);
    const fontInKit = meta.font_family ? kit.has(meta.font_family.toLowerCase()) : null;
    components[c.name] = {
      file: `${c.name}/${c.name}.html`,
      files: files.map((f) => `${c.name}/${f}`),
      suited_for: c.suited_for,
      word_level: c.suited_for.some((a) => a === "word-by-word" || a === "karaoke"),
      consumes_transcript: meta.consumes_transcript,
      font_family: meta.font_family,
      font_in_kit: fontInKit,
      external: { gsap_cdn: meta.has_gsap, google_fonts_link: meta.has_google_fonts_link },
      bytes: meta.bytes,
      note: c.note,
    };
  }
  const manifest = {
    kind: "video-vob-caption-kit",
    generated_with_hyperframes: version,
    note: "Vetted REFERENCE caption compositions sourced from the hyperframes registry via `hyperframes add`. Adapt them (do NOT copy verbatim): use the vendored ./fonts.css kit instead of the Google-Fonts <link>, stamp data-vob-caption-id on bound captions, and feed real per-word timing to word-level/karaoke components. See README.md.",
    animations: ANIMATIONS,
    components,
  };
  fs.writeFileSync(path.join(CAPTIONS_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function renderReadme(manifest) {
  const rows = COMPONENTS.map((c) => {
    const m = manifest.components[c.name];
    const kit = m.font_in_kit === null ? "?" : (m.font_in_kit ? "yes" : "NO — substitute a kit family");
    return `| \`${c.name}\` | ${c.suited_for.join(", ")} | ${m.word_level ? "yes" : "no"} | ${m.font_family || "?"} (${kit}) |`;
  });
  return `# video-vob caption kit

Built by \`scripts/build-captions.js\` from the hyperframes registry
(\`hyperframes add <name>\`), generated with hyperframes \`${manifest.generated_with_hyperframes}\`.
**The script is the source of truth; these assets are committed.** Re-run
\`node scripts/build-captions.js\` to refresh to the installed hyperframes.

Each \`<name>/<name>.html\` is a self-contained, lint-clean REFERENCE composition.
The composer READS them (the kit is symlinked into \`compose/captions/\` on every
save, like \`./fonts.css\`) and ADAPTS the technique — it does **not** copy them
verbatim.

## Required adaptations (the composer's contract)

1. **Fonts:** the references load their face from a \`fonts.googleapis.com\` \`<link>\`.
   That trips hyperframes' own \`google_fonts_import\` lint rule. Use the vendored
   kit instead: load \`./fonts.css\` and reference the family by name. If the
   component's font is **not** in the kit (see the table), substitute the nearest
   kit family (or extend the font kit — out of scope here).
2. **Animation engine:** the references drive their timeline with GSAP and register
   it at \`window.__timelines["<composition-id>"]\` — the hyperframes runtime
   contract. Keep that registration.
3. **Binding:** stamp \`data-vob-caption-id="<id>"\` on the implementing chunk for any
   \`caption_segment\` that carries an authored \`id\` (\`exact:true\` makes it required —
   COMPOSE QC errors otherwise).
4. **Word-level / karaoke:** components flagged \`word_level\`/\`consumes_transcript\`
   want a real per-word \`[{text,start,end}]\` transcript (from the spawn's
   \`per_clip_transcripts\` → \`inspect/transcripts/file_<i>.json\`). When
   \`transcript_aligned\` is false, DOWNGRADE word-by-word/karaoke to chunk-level
   \`pop\` (mirrors the \`PLAN_CAPTION_KARAOKE_UNALIGNED\` plan-lint warning).

## animation → component

| animation | default | alternates |
|---|---|---|
| \`pop\` | \`${manifest.animations.pop.default}\` | ${manifest.animations.pop.alternates.map((a) => `\`${a}\``).join(", ") || "—"} |
| \`word-by-word\` | \`${manifest.animations["word-by-word"].default}\` | ${manifest.animations["word-by-word"].alternates.map((a) => `\`${a}\``).join(", ") || "—"} |
| \`karaoke\` | \`${manifest.animations.karaoke.default}\` | ${manifest.animations.karaoke.alternates.map((a) => `\`${a}\``).join(", ") || "—"} |

## components

\`word-level\` = the component animates per word (vs per chunk). It is distinct from
\`consumes_transcript\` (in \`manifest.json\`): a word-level component animates words
sequentially and works from chunk text + even spacing, but only \`consumes_transcript\`
components (e.g. \`caption-pill-karaoke\`) need a REAL per-word \`{start,end}\` transcript
to stay in sync — those are the ones to downgrade to \`pop\` when \`transcript_aligned\`
is false.

| component | suited for | word-level | font (in kit?) |
|---|---|---|---|
${rows.join("\n")}

\`manifest.json\` carries the machine-readable form (file lists, \`external\` deps,
\`bytes\`). See \`LICENSES.md\` for provenance.
`;
}

function renderLicenses(manifest) {
  return `# Caption kit provenance & attribution

The caption components under \`mcp/assets/captions/\` are sourced from the
**hyperframes** registry (\`hyperframes add <name>\`), generated with hyperframes
\`${manifest.generated_with_hyperframes}\`. They are authored by the hyperframes
project and vendored here as **reference** material.

video-vob already depends on and pins the hyperframes CLI (it is the rendering
engine), and these components ship inside that package; vendoring them as
reference keeps the COMPOSE side offline and lint-clean by construction.

> ⚠️ **Open item (PRD 01 R2 — redistribution not yet confirmed).** The installed
> hyperframes package declares **no SPDX \`license\` field and ships no LICENSE
> file**, so the redistribution terms of these vendored components are
> UNCONFIRMED. They are retained here on the basis that video-vob already bundles
> and pins hyperframes (the same toolchain) and uses them only as composer
> reference. **Confirm redistributability with the hyperframes maintainers before
> publishing this template publicly**; if it cannot be confirmed, the kit can be
> dropped (the COMPOSE side degrades to authoring captions unaided — the engine
> handles an absent kit gracefully).

Re-running \`scripts/build-captions.js\` re-materializes them from whatever
hyperframes version is installed (pinned in \`manifest.json\` as
\`generated_with_hyperframes\`).

Components vendored: ${COMPONENTS.map((c) => `\`${c.name}\``).join(", ")}.
`;
}

function main() {
  const manifestOnly = process.argv.includes("--manifest-only");
  const version = hyperframesVersion();
  fs.mkdirSync(CAPTIONS_DIR, { recursive: true });

  if (!manifestOnly) {
    // Fresh build: drop stale component subdirs, then re-materialize each.
    for (const entry of fs.readdirSync(CAPTIONS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) fs.rmSync(path.join(CAPTIONS_DIR, entry.name), { recursive: true, force: true });
    }
    let total = 0;
    for (const c of COMPONENTS) {
      try {
        const files = materializeComponent(c.name);
        total += files.length;
        console.log(`  ok   ${c.name} (${files.length} file${files.length === 1 ? "" : "s"})`);
      } catch (err) {
        console.error(`  FAIL ${c.name}: ${err.message || err}`);
        process.exit(1);
      }
    }
    console.log(`\nMaterialized ${COMPONENTS.length} components, ${total} files (hyperframes ${version}).`);
  }

  const manifest = buildManifest(version);
  fs.writeFileSync(path.join(CAPTIONS_DIR, "README.md"), renderReadme(manifest));
  fs.writeFileSync(path.join(CAPTIONS_DIR, "LICENSES.md"), renderLicenses(manifest));
  console.log(`Wrote ${path.relative(process.cwd(), path.join(CAPTIONS_DIR, "manifest.json"))} (${Object.keys(manifest.components).length} components, animations: ${Object.keys(manifest.animations).join("/")}).`);
  console.log(`Wrote README.md + LICENSES.md.`);
}

main();
