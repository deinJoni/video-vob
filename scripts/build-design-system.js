"use strict";

// build-design-system.js — (re)build the vendored design-system kit under
// mcp/assets/design-system/.
//
// Sibling of scripts/build-captions.js, but the components here are FIRST-PARTY
// (authored in-repo), not pulled from the hyperframes registry. They are
// self-contained, PURE-CSS, token-parameterized REFERENCE compositions the
// composer ADAPTS — vetted, lint-clean visual systems (titles, lower-thirds,
// grades, motion, backdrops) per video-type, so COMPOSE's default output is
// striking, not "lint-clean AI slop". The script is the SOURCE OF TRUTH; the
// assets + manifest are committed.
//
//   node scripts/build-design-system.js                 # lint every component + write manifest/README/LICENSES
//   node scripts/build-design-system.js --manifest-only # regen manifest/README/LICENSES, NO lint (preserves each component's prior lint verdict from the existing manifest)
//   node scripts/build-design-system.js --skip-lint      # build + write but skip the lint pass (same prior-verdict preservation)
//   node scripts/build-design-system.js --snapshot       # additionally render a 3-frame snapshot per component (slow)
//
// The lint pass is the "vetted" guarantee: each <name>/<name>.html is copied to a
// throwaway OS temp dir as index.html and run through `hyperframes lint --json`;
// any ERROR fails the build. (References use hyperframes' AUTO-RESOLVED font
// families and NO font <link>, so they lint clean standalone — the composer
// substitutes the brief's family + loads ./fonts.css for house faces at COMPOSE.)
//
// Node >= 22. Zero npm deps. Shells the installed `hyperframes` CLI at build time
// only (dev tooling — the engine's one-runner policy governs RUN time).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DS_DIR = path.resolve(__dirname, "..", "mcp", "assets", "design-system");

// The CSS custom properties a component may read (the token contract; tokens.css
// documents them). The composer sets these once on its composition root from
// target.design and the whole kit re-skins.
const TOKENS = [
  "vob-bg",
  "vob-surface",
  "vob-text",
  "vob-text-muted",
  "vob-accent",
  "vob-accent-2",
  "vob-safe-top",
  "vob-safe-bottom",
];

const KINDS = ["title", "lower_third", "grade", "motion", "backdrop", "callout", "end_card"];

// Font families hyperframes auto-resolves (bundled / @fontsource), usable in a
// reference WITHOUT a font <link>. Probed against hyperframes 0.6.112. House faces
// NOT in this set (Anton, Hanken Grotesk, Noto Sans/Serif SC) must NOT appear in a
// reference — they error standalone (no @font-face in scope); the composer brings
// them in via ./fonts.css at COMPOSE. ("Bebas Neue" auto-aliases to League Gothic
// — use League Gothic directly.)
const AUTO_RESOLVED_FONTS = [
  "League Gothic",
  "Archivo Black",
  "Oswald",
  "Montserrat",
  "Poppins",
  "Outfit",
  "Open Sans",
  "Lato",
  "Roboto",
  "Nunito",
  "Inter",
  "Playfair Display",
  "EB Garamond",
  "JetBrains Mono",
  "IBM Plex Mono",
  "Source Code Pro",
  "Space Mono",
  "Noto Sans JP",
];
// House faces the kit adds beyond hyperframes' auto-resolved set (render only via a
// ./fonts.css <link>, which the composer adds — references must NOT use them as a primary).
const HOUSE_FONTS = ["Anton", "Bebas Neue", "Hanken Grotesk", "Noto Serif SC", "Noto Sans SC"];
// Every real kit family (lowercased) — used to filter detected `fonts` so a system
// FALLBACK (e.g. "Helvetica Neue") in a stack isn't reported as a kit font.
const KIT_FONTS = new Set([...AUTO_RESOLVED_FONTS, ...HOUSE_FONTS].map((f) => f.toLowerCase()));
const GENERIC_FONTS = new Set([
  "sans-serif",
  "serif",
  "monospace",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "cursive",
  "fantasy",
  "inherit",
  "initial",
]);

// Hand-authored component registry. `kind` + `suited_for` (video-types) + `note`
// are editorial; everything else (fonts, tokens, pure-css, keyframes, bytes, lint)
// is DETECTED from disk so the manifest can't drift.
const COMPONENTS = [
  // titles
  { name: "title-bold-slam", kind: "title", suited_for: ["social-short", "general"], note: "Punchy full-frame title: heavy condensed caps, accent 2nd line + accent rule, slam-in → hold → slam-out. Retention/social default." },
  { name: "title-clean-kicker", kind: "title", suited_for: ["long-form", "tutorial", "general"], note: "Editorial left-aligned title: accent UPPERCASE tracked kicker over a large clean headline that rises in; thin accent underline. Calm, whitespace-heavy." },
  { name: "title-editorial-serif", kind: "title", suited_for: ["cinematic"], note: "Cinematic centered serif (Playfair) with a thin rule + italic subtitle; slow scale-fade, maximal negative space, muted gold accent." },
  { name: "title-quote-card", kind: "title", suited_for: ["podcast"], note: "Pull-quote card: big accent quote glyph, serif quote, attribution line (name · role). Soft fade+rise. Podcast/long-form." },
  { name: "title-kinetic-stack", kind: "title", suited_for: ["social-short"], note: "3 heavy condensed-caps lines slam in staggered (data-start), middle line in accent. Energetic vertical social title." },
  // lower-thirds
  { name: "lower-third-bold-bar", kind: "lower_third", suited_for: ["social-short"], note: "Heavy uppercase name on a solid accent bar that wipes in from the left; role on a dark bar below. Punchy, high-contrast (vertical)." },
  { name: "lower-third-accent-edge", kind: "lower_third", suited_for: ["long-form", "general"], note: "Name + muted role on a translucent dark pill with a thick accent left edge; slide+fade in. Clean editorial." },
  { name: "lower-third-serif-minimal", kind: "lower_third", suited_for: ["cinematic"], note: "Letter-spaced Playfair name + thin rule + italic muted role; fade-rise only. Elegant/cinematic." },
  { name: "lower-third-name-role", kind: "lower_third", suited_for: ["podcast", "long-form"], note: "Two-line speaker intro: accent tick + large name + uppercase muted role; gentle slide-up + fade." },
  { name: "lower-third-pill", kind: "lower_third", suited_for: ["tutorial", "general"], note: "Rounded pill with a leading accent dot + single label; pop-in (scale + fade). Friendly/functional." },
  // grades (full-frame; the file's top comment carries the composer's filter: string + overlay layers)
  { name: "grade-punch", kind: "grade", suited_for: ["social-short"], note: "High-contrast vivid: filter contrast/saturate/brightness + subtle vignette. Punchy." },
  { name: "grade-teal-orange", kind: "grade", suited_for: ["cinematic", "general"], note: "Cinematic teal-shadows / orange-highlights look via multiply + soft-light overlays. Signature 'film' grade." },
  { name: "grade-film-desat", kind: "grade", suited_for: ["cinematic"], note: "Muted filmic: desaturate + slight sepia + fine film-grain + soft vignette. Understated." },
  { name: "grade-warm", kind: "grade", suited_for: ["long-form", "podcast", "general"], note: "Cozy warm: sepia/saturate/hue-rotate + amber soft-light tint." },
  { name: "grade-cool", kind: "grade", suited_for: ["general"], note: "Crisp cool: saturate/hue-rotate + cool blue soft-light tint." },
  { name: "grade-clean", kind: "grade", suited_for: ["long-form", "tutorial", "podcast", "general"], note: "Near-noop 'intentionally crisp' baseline for video-types whose grade is 'none' — slight contrast/saturate + barely-there vignette." },
  { name: "grade-bw", kind: "grade", suited_for: ["cinematic"], note: "Dramatic monochrome: grayscale + contrast + grain + strong vignette." },
  // motion presets (the file's top comment documents the in/out eases + durations for the composer)
  { name: "motion-fast-snap", kind: "motion", suited_for: ["social-short"], note: "Energetic entrance: in 0.3s cubic-bezier(.2,.9,.2,1) overshoot, out 0.25s; translateY+scale. Social." },
  { name: "motion-medium-soft", kind: "motion", suited_for: ["long-form", "tutorial", "podcast", "general"], note: "Balanced: in 0.5s cubic-bezier(.22,1,.36,1), out 0.4s ease-in; fade + 28px rise." },
  { name: "motion-slow-cinematic", kind: "motion", suited_for: ["cinematic"], note: "Serene: in 0.9s cubic-bezier(.4,0,.2,1), out 0.8s; fade + subtle scale(1.04→1) + long holds." },
  // furniture
  { name: "callout-arrow-pill", kind: "callout", suited_for: ["tutorial"], note: "Off-center rounded pill label with a CSS-triangle arrow pointing at a target; pop-in, hold, fade. Tutorial callout." },
  { name: "callout-number-step", kind: "callout", suited_for: ["tutorial"], note: "Circular accent number badge + step label beside it (badge then label, staggered). Step-by-step." },
  { name: "end-card-cta", kind: "end_card", suited_for: ["social-short", "long-form"], note: "Strong end card owning the last ~3s: big headline + handle + accent button pill. Slam entrances. CTA." },
  // backdrops
  { name: "backdrop-spotlight", kind: "backdrop", suited_for: ["social-short", "general"], note: "Near-black with a soft accent-tinted radial spotlight + vignette + slow glow breathe. Makes foreground pop (vertical)." },
  { name: "backdrop-gradient-sweep", kind: "backdrop", suited_for: ["general", "long-form"], note: "Smooth diagonal bg→surface gradient with corner accent pools + a slow panning sheen. Premium/clean." },
  { name: "backdrop-film-bars", kind: "backdrop", suited_for: ["cinematic"], note: "Cinemascope letterbox bars + graded center band + vignette + faint grain. Cinematic framing." },
  { name: "backdrop-grid", kind: "backdrop", suited_for: ["tutorial"], note: "Subtle dark tech grid + accent quadrant glow + slow parallax drift. Tech/tutorial." },
  { name: "backdrop-soft-studio", kind: "backdrop", suited_for: ["podcast"], note: "Soft warm-neutral two-tone studio gradient + smooth vignette + gentle light breathe. Calm talking-head." },
];

// Per-video-type LOOK bundles — the opinionated curation. `principles` are taste
// guardrails handed to the composer verbatim; the slot refs name the recommended
// component per role (unresolved refs are dropped from the written manifest with a
// warning, so this can name Phase-2 components ahead of authoring them).
const VIDEO_TYPES = {
  "social-short": {
    look: "punchy, high-energy, retention-first",
    principles: [
      "Big heavy condensed display type (League Gothic / Archivo Black), UPPERCASE, tight leading (~0.9).",
      "ONE dominant accent against near-black; high contrast; saturated.",
      "Fast snappy motion — slam/scale-in 0.25–0.45s, nothing lingers; energy beats can whip/punch.",
      "Titles ride the upper third (above a talking head); captions are bold-pop lower-third.",
      "Generous size over generous spacing — fill the frame, it's watched small.",
    ],
    slots: {
      title: { default: "title-bold-slam", alternates: ["title-kinetic-stack"] },
      lower_third: { default: "lower-third-bold-bar", alternates: [] },
      grade: { default: "grade-punch", alternates: ["grade-teal-orange"] },
      motion: { default: "motion-fast-snap", alternates: [] },
      backdrop: { default: "backdrop-spotlight", alternates: ["backdrop-gradient-sweep"] },
      end_card: { default: "end-card-cta", alternates: [] },
    },
    transition_guidance: "Cut-heavy; reserve whip_pan / zoom_punch (≤0.35s) for energy beats.",
  },
  "long-form": {
    look: "clean editorial, readable, chaptered",
    principles: [
      "Calm grotesque headlines (Hanken Grotesk / Outfit) with generous whitespace; sentence or title case.",
      "Restrained, soft motion (0.4–0.6s ease); let content breathe.",
      "Chapter/section cards at boundaries; lower-thirds introduce speakers; cool blue accent.",
      "16:9 safe margins; never crowd the edges; one idea per card.",
    ],
    slots: {
      title: { default: "title-clean-kicker", alternates: [] },
      lower_third: { default: "lower-third-accent-edge", alternates: ["lower-third-name-role"] },
      grade: { default: "grade-clean", alternates: ["grade-warm"] },
      motion: { default: "motion-medium-soft", alternates: [] },
      backdrop: { default: "backdrop-gradient-sweep", alternates: [] },
      end_card: { default: "end-card-cta", alternates: [] },
    },
    transition_guidance: "cut / dip between scenes; crossfade at section boundaries.",
  },
  cinematic: {
    look: "filmic, restrained, elegant (24fps)",
    principles: [
      "Refined serif display (Playfair Display) + serif body (EB Garamond); lots of negative space.",
      "Slow, smooth motion (0.7–1.0s, gentle ease); long holds; nothing snappy.",
      "Letterbox feel; desaturated/teal-orange grade; muted gold accent; small minimal lower-thirds.",
      "Center or rule-of-thirds compositions; type is small and confident, never shouting.",
    ],
    slots: {
      title: { default: "title-editorial-serif", alternates: [] },
      lower_third: { default: "lower-third-serif-minimal", alternates: [] },
      grade: { default: "grade-film-desat", alternates: ["grade-teal-orange"] },
      motion: { default: "motion-slow-cinematic", alternates: [] },
      backdrop: { default: "backdrop-film-bars", alternates: [] },
    },
    transition_guidance: "cut / dip; slow crossfade or focus_pull between acts; never whip/zoom.",
  },
  tutorial: {
    look: "clear, functional, high-legibility",
    principles: [
      "Plain sans (Inter) headlines + body; mono (JetBrains Mono) for code/keys/numbers.",
      "Step indicators and callouts that POINT at the thing; never decorative.",
      "Soft, quick motion; green 'go/correct' accent; high text contrast on solid panels.",
      "Keep the demo readable — overlays hug a safe edge, never cover the action.",
    ],
    slots: {
      title: { default: "title-clean-kicker", alternates: [] },
      lower_third: { default: "lower-third-pill", alternates: [] },
      grade: { default: "grade-clean", alternates: [] },
      motion: { default: "motion-medium-soft", alternates: [] },
      callout: { default: "callout-arrow-pill", alternates: ["callout-number-step"] },
      backdrop: { default: "backdrop-grid", alternates: [] },
    },
    transition_guidance: "cut / dip; slide for step-to-step; avoid flashy transitions.",
  },
  podcast: {
    look: "minimal, speaker-forward, quotable",
    principles: [
      "Calm grotesque (Hanken Grotesk); big pull-quote cards; speaker name + role lower-thirds.",
      "Soft medium motion; muted purple accent; lots of stillness (it's talking heads).",
      "Frame the speaker; keep furniture minimal; one quote on screen at a time.",
    ],
    slots: {
      title: { default: "title-quote-card", alternates: [] },
      lower_third: { default: "lower-third-name-role", alternates: [] },
      grade: { default: "grade-clean", alternates: ["grade-warm"] },
      motion: { default: "motion-medium-soft", alternates: [] },
      backdrop: { default: "backdrop-soft-studio", alternates: [] },
    },
    transition_guidance: "cut / dip; gentle crossfade between segments.",
  },
  general: {
    look: "balanced, versatile, clean",
    principles: [
      "Neutral sans (Inter / Outfit); moderate weight contrast; one clear accent.",
      "Medium-soft motion (0.4–0.6s); comfortable margins; legible at any size.",
      "Adapt density to platform: tighter & bolder if vertical, airier if 16:9.",
    ],
    slots: {
      title: { default: "title-clean-kicker", alternates: ["title-bold-slam"] },
      lower_third: { default: "lower-third-accent-edge", alternates: ["lower-third-pill"] },
      grade: { default: "grade-clean", alternates: ["grade-warm", "grade-cool"] },
      motion: { default: "motion-medium-soft", alternates: [] },
      backdrop: { default: "backdrop-gradient-sweep", alternates: ["backdrop-spotlight"] },
    },
    transition_guidance: "cut / crossfade / dip — match the destination platform's energy.",
  },
};

function hyperframesVersion() {
  try {
    const out = execFileSync("hyperframes", ["--version"], { encoding: "utf8", timeout: 20000 }).trim();
    const m = out.match(/(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/);
    return m ? m[1] : out.slice(0, 32);
  } catch {
    return "unknown";
  }
}

// --- on-disk metadata detection ---------------------------------------------
function detectFonts(html) {
  const fonts = new Set();
  const re = /font-family:\s*([^;}{]+)[;}]/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    for (const tok of m[1].split(",")) {
      let fam = tok.trim().replace(/^["']|["']$/g, "").trim();
      if (!fam) continue;
      if (/^var\(/i.test(fam)) continue; // var() handled by tokens, not a literal family
      if (GENERIC_FONTS.has(fam.toLowerCase())) continue;
      if (!KIT_FONTS.has(fam.toLowerCase())) continue; // drop system FALLBACKS — report only real kit families
      fonts.add(fam);
    }
  }
  return [...fonts];
}

function detectTokens(html) {
  const used = new Set();
  const re = /var\(\s*--(vob-[a-z0-9-]+)/gi;
  let m;
  while ((m = re.exec(html)) !== null) used.add(m[1]);
  return [...used].sort();
}

function detectMeta(name, files) {
  const htmlPath = path.join(DS_DIR, name, `${name}.html`);
  const html = fs.readFileSync(htmlPath, "utf8");
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.statSync(path.join(DS_DIR, name, f)).size;
    } catch {}
  }
  // Detect ACTUAL gsap usage (CDN script or API call) — not prose mentions in the
  // doc comment (which says "never GSAP"). The inert inline stub has no src.
  const usesGsap =
    /<script[^>]+gsap/i.test(html) ||
    /\bgsap\s*\.\s*(timeline|to|from|fromTo|set|registerPlugin|context|ticker)\b/i.test(html);
  const externalScript = /<script[^>]+\bsrc\s*=/i.test(html);
  const wm = html.match(/data-width="(\d+)"/);
  const hm = html.match(/data-height="(\d+)"/);
  return {
    fonts: detectFonts(html),
    tokens_used: detectTokens(html),
    has_keyframes: /@keyframes/i.test(html),
    pure_css: !usesGsap && !externalScript,
    uses_gsap: usesGsap,
    dims: wm && hm ? `${wm[1]}x${hm[1]}` : null,
    bytes,
  };
}

// Lint one component standalone: copy to an OS temp dir as index.html and run
// `hyperframes lint --json`. References carry no font <link> + use auto-resolved
// families, so the temp dir needs nothing else.
function lintComponent(name) {
  const src = path.join(DS_DIR, name, `${name}.html`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vob-ds-"));
  try {
    fs.copyFileSync(src, path.join(tmp, "index.html"));
    let out;
    try {
      out = execFileSync("hyperframes", ["lint", tmp, "--json"], { encoding: "utf8", timeout: 60000 });
    } catch (err) {
      // lint exits non-zero when it finds errors but still prints JSON on stdout
      out = (err.stdout && err.stdout.toString()) || "";
    }
    const parsed = JSON.parse(out);
    return {
      ok: parsed.errorCount === 0,
      errorCount: parsed.errorCount || 0,
      warningCount: parsed.warningCount || 0,
      findings: (parsed.findings || []).filter((f) => f.severity === "error"),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function snapshotComponent(name) {
  const src = path.join(DS_DIR, name, `${name}.html`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vob-ds-snap-"));
  fs.copyFileSync(src, path.join(tmp, "index.html"));
  const env = {
    ...process.env,
    PRODUCER_BROWSER_GPU_MODE: process.env.PRODUCER_BROWSER_GPU_MODE || "software",
    HYPERFRAMES_NO_UPDATE_CHECK: "1",
    HYPERFRAMES_NO_AUTO_INSTALL: "1",
    PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS: "300000",
    PRODUCER_PLAYER_READY_TIMEOUT_MS: "120000",
    PRODUCER_RENDER_READY_TIMEOUT_MS: "120000",
  };
  try {
    execFileSync("hyperframes", ["snapshot", tmp, "--frames", "3", "--describe", "false"], {
      encoding: "utf8",
      timeout: 300000,
      env,
    });
    const dest = path.join(DS_DIR, name, "preview");
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(path.join(tmp, "snapshots"), dest, { recursive: true });
    return true;
  } catch (err) {
    console.error(`  snapshot FAIL ${name}: ${(err.message || err).toString().slice(0, 120)}`);
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// When NOT linting (--manifest-only / --skip-lint), preserve each component's prior
// lint verdict from the existing manifest so a doc-only regen never downgrades a
// committed "clean" to "skipped".
function readPriorLint() {
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(DS_DIR, "manifest.json"), "utf8"));
    const map = {};
    for (const [n, c] of Object.entries(prev.components || {})) if (c && c.lint) map[n] = c.lint;
    return map;
  } catch {
    return {};
  }
}

function buildComponents({ lint, snapshot }) {
  const components = {};
  let lintFailures = 0;
  const priorLint = lint ? {} : readPriorLint();
  for (const c of COMPONENTS) {
    const dir = path.join(DS_DIR, c.name);
    if (!fs.existsSync(path.join(dir, `${c.name}.html`))) {
      throw new Error(`component missing: ${path.join(c.name, `${c.name}.html`)} — author it before referencing it in COMPONENTS`);
    }
    if (!KINDS.includes(c.kind)) {
      throw new Error(`component ${c.name}: unknown kind "${c.kind}" (known: ${KINDS.join(", ")})`);
    }
    const files = fs
      .readdirSync(dir)
      .filter((f) => f !== "preview" && !f.endsWith(".md"))
      .sort();
    const meta = detectMeta(c.name, files);
    let lintStatus = priorLint[c.name] || "skipped";
    if (lint) {
      const v = lintComponent(c.name);
      lintStatus = v.ok ? "clean" : `errors:${v.errorCount}`;
      if (!v.ok) {
        lintFailures += 1;
        console.error(`  LINT FAIL ${c.name}: ${v.findings.map((f) => f.code).join(", ")}`);
      } else {
        console.log(`  ok   ${c.name} (${c.kind}, ${meta.bytes} bytes, lint clean${meta.pure_css ? ", pure-css" : ""})`);
      }
    } else {
      console.log(`  ---  ${c.name} (${c.kind}, ${meta.bytes} bytes, lint ${lintStatus === "skipped" ? "skipped" : lintStatus + " (preserved)"})`);
    }
    if (snapshot) snapshotComponent(c.name);
    if (!meta.pure_css) {
      console.error(`  WARN ${c.name}: not pure CSS (gsap/external script detected) — design-system components must be pure CSS`);
    }
    components[c.name] = {
      kind: c.kind,
      file: `${c.name}/${c.name}.html`,
      files: files.map((f) => `${c.name}/${f}`),
      suited_for: c.suited_for,
      dims: meta.dims,
      fonts: meta.fonts,
      tokens_used: meta.tokens_used,
      pure_css: meta.pure_css,
      has_keyframes: meta.has_keyframes,
      lint: lintStatus,
      bytes: meta.bytes,
      note: c.note,
    };
  }
  if (lint && lintFailures > 0) {
    throw new Error(`${lintFailures} component(s) failed lint — fix before committing the kit`);
  }
  return components;
}

// Drop unresolved slot refs (components not yet authored) so the written manifest
// never points at a missing file; warn so half-built bundles are visible.
function resolveVideoTypes(components) {
  const known = new Set(Object.keys(components));
  const out = {};
  for (const [vt, bundle] of Object.entries(VIDEO_TYPES)) {
    const slots = {};
    for (const [role, ref] of Object.entries(bundle.slots || {})) {
      const def = known.has(ref.default) ? ref.default : null;
      const alts = (ref.alternates || []).filter((a) => known.has(a));
      if (!def && alts.length === 0) {
        if (ref.default) console.warn(`  note ${vt}.${role}: "${ref.default}" not built yet — slot omitted`);
        continue;
      }
      slots[role] = { default: def || alts[0], alternates: def ? alts : alts.slice(1) };
    }
    out[vt] = {
      look: bundle.look,
      principles: bundle.principles,
      slots,
      transition_guidance: bundle.transition_guidance,
    };
  }
  return out;
}

function buildManifest({ lint, snapshot, version }) {
  const components = buildComponents({ lint, snapshot });
  const video_types = resolveVideoTypes(components);
  const manifest = {
    kind: "video-vob-design-kit",
    verified_with_hyperframes: version,
    note:
      "First-party, PURE-CSS, token-parameterized REFERENCE design components per video-type. ADAPT the technique; never copy verbatim. Set the --vob-* tokens (see tokens.css) once on your composition root from target.design, substitute each component's concrete font family with target.design.typography (load ./fonts.css for house faces), and re-time elements to your scene windows. Stagger with data-start (NEVER animation-delay — the runtime hijacks it to scrub paused CSS animations). See README.md.",
    token_contract: "tokens.css",
    tokens: TOKENS,
    kinds: KINDS,
    auto_resolved_fonts: AUTO_RESOLVED_FONTS,
    video_types,
    components,
  };
  fs.writeFileSync(path.join(DS_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function renderReadme(manifest) {
  const byKind = {};
  for (const [name, c] of Object.entries(manifest.components)) {
    (byKind[c.kind] = byKind[c.kind] || []).push({ name, ...c });
  }
  const kindSections = KINDS.filter((k) => byKind[k]).map((k) => {
    const rows = byKind[k]
      .map((c) => `| \`${c.name}\` | ${c.suited_for.join(", ")} | ${c.fonts.join(", ") || "—"} | ${c.lint} |`)
      .join("\n");
    return `### ${k}\n\n| component | suited for | fonts | lint |\n|---|---|---|---|\n${rows}`;
  });
  const vtSections = Object.entries(manifest.video_types).map(([vt, b]) => {
    const slots = Object.entries(b.slots)
      .map(([role, ref]) => `- **${role}**: \`${ref.default}\`${ref.alternates.length ? ` (alt: ${ref.alternates.map((a) => `\`${a}\``).join(", ")})` : ""}`)
      .join("\n");
    const principles = b.principles.map((p) => `  - ${p}`).join("\n");
    return `### ${vt} — _${b.look}_\n\n${principles}\n\n${slots || "  - _(components pending)_"}\n\n  Transitions: ${b.transition_guidance}`;
  });
  return `# video-vob design-system kit

First-party, **pure-CSS**, token-parameterized REFERENCE design components — vetted
visual systems (titles, lower-thirds, grades, motion, backdrops) per video-type, so
COMPOSE's default output is striking, not "lint-clean AI slop". Built by
\`scripts/build-design-system.js\` (the source of truth; these assets are committed),
lint-verified against hyperframes \`${manifest.verified_with_hyperframes}\`.

The kit is symlinked into \`compose/design-system/\` on every save (beside \`./fonts.css\`
and \`./captions/\`). The composer READS \`./design-system/manifest.json\` + the per-component
reference HTML and ADAPTS the technique — it does **not** copy them verbatim.

## The composer's contract (every component)

1. **Pure CSS \`@keyframes\` — never GSAP.** hyperframes' css adapter scrubs a \`paused\`
   animation to each frame via \`animation-delay = -(T − data-start)\`. Keep
   \`animation-fill-mode: both\` + \`animation-play-state: paused\`.
2. **Stagger with \`data-start\`, NEVER \`animation-delay\`** (the runtime hijacks
   animation-delay). Each staggered piece is its own \`class="clip"\` element.
3. **Tokens, not hard-coded brand.** Set the \`--vob-*\` custom properties (see
   \`tokens.css\`) once on your composition root from \`target.design\`; components read them
   with a literal fallback (\`var(--vob-accent, #ff3b30)\`).
4. **Fonts:** references use hyperframes' auto-resolved families (\`${manifest.auto_resolved_fonts.slice(0, 6).join(", ")}\`, …).
   Substitute the concrete family with \`target.design.typography.{headline|body|caption}\`;
   load \`./fonts.css\` for house faces (Anton / Hanken Grotesk / Noto SC) when the brief names them.
5. Every timed element: \`class="clip"\` + stable \`id\` + \`data-start\`/\`data-duration\`/\`data-track-index\`
   (≥1; a distinct track per time-overlapping element); \`animation-duration == data-duration\`.

## Looks by video-type

${vtSections.join("\n\n")}

## Components

${kindSections.join("\n\n")}

\`manifest.json\` carries the machine-readable form (per-component \`kind\`, \`file\`, \`fonts\`,
\`tokens_used\`, \`pure_css\`, \`lint\`, \`bytes\`; the per-video-type \`video_types\` map). See
\`LICENSES.md\` for provenance.
`;
}

function renderLicenses(manifest) {
  return `# Design-system kit — provenance & license

The components under \`mcp/assets/design-system/\` are **first-party, original work**
authored for video-vob — self-contained, pure-CSS reference compositions. They vendor
**no third-party component code** (unlike the caption kit, which is sourced from the
hyperframes registry), so there is no external redistribution question: they ship under
the same license as this repository.

Fonts are referenced **by family name only** (hyperframes' auto-resolved families); no
font binaries are embedded here. The vendored font kit (\`mcp/assets/fonts/\`) carries its
own OFL/Apache licenses (\`mcp/assets/fonts/LICENSES.md\`).

Lint-verified against hyperframes \`${manifest.verified_with_hyperframes}\` (recorded in
\`manifest.json\` as \`verified_with_hyperframes\`). Re-run \`node scripts/build-design-system.js\`
to re-verify against the installed hyperframes.

Components: ${Object.keys(manifest.components).map((n) => `\`${n}\``).join(", ")}.
`;
}

function main() {
  const manifestOnly = process.argv.includes("--manifest-only");
  const snapshot = process.argv.includes("--snapshot");
  const lint = !manifestOnly && !process.argv.includes("--skip-lint");
  const version = hyperframesVersion();
  fs.mkdirSync(DS_DIR, { recursive: true });

  console.log(`Building design-system kit (${COMPONENTS.length} components, hyperframes ${version}, lint ${lint ? "ON" : "off"})...`);
  const manifest = buildManifest({ lint, snapshot, version });
  fs.writeFileSync(path.join(DS_DIR, "README.md"), renderReadme(manifest));
  fs.writeFileSync(path.join(DS_DIR, "LICENSES.md"), renderLicenses(manifest));
  console.log(
    `\nWrote ${path.relative(process.cwd(), path.join(DS_DIR, "manifest.json"))} (${Object.keys(manifest.components).length} components across ${Object.keys(manifest.video_types).length} video-types).`,
  );
  console.log("Wrote README.md + LICENSES.md.");
}

main();
