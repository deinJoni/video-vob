"use strict";

// build-fonts.js — (re)build the vendored font kit under mcp/assets/.
//
// Fetches each family's woff2 from @fontsource (jsDelivr) and regenerates
// mcp/assets/fonts.css from the SAME manifest, so the @font-face rules can
// never drift from the files on disk. Mirrors hyperframes' own `build:fonts`
// step, but vendors the result (offline + deterministic + lint-clean — the
// hyperframes font lint only objects to googleapis CDN links, not local
// @font-face). Re-run to refresh to latest upstream:
//
//   node scripts/build-fonts.js            # download + regenerate fonts.css
//   node scripts/build-fonts.js --css-only # regenerate fonts.css only (no fetch)
//
// Node >= 22 (global fetch). Zero npm deps, like the rest of the engine.

const fs = require("fs");
const path = require("path");

const FONTS_DIR = path.resolve(__dirname, "..", "mcp", "assets", "fonts");
const CSS_PATH = path.resolve(__dirname, "..", "mcp", "assets", "fonts.css");
const CDN = "https://cdn.jsdelivr.net/npm";

// Each entry vendors ONE CSS family. `variable:true` → one wght-axis woff2
// covering 100..900 (one @font-face). `variable:false` → one woff2 per listed
// weight (one @font-face each). `subset` is the @fontsource file subset
// ("latin" covers ASCII + Latin-1, incl. German umlauts ä ö ü ß; CJK families
// use their script subset). license/copyright feed NOTICE + LICENSES.md.
const FAMILIES = [
  // ---- existing kit (kept; Anton/Bebas Neue are not in hyperframes) ----------
  { name: "Inter", slug: "inter", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter)" },
  { name: "Anton", slug: "anton", variable: false, weights: [400], subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2020 The Anton Project Authors (https://github.com/googlefonts/AntonFont)" },
  { name: "Bebas Neue", slug: "bebas-neue", variable: false, weights: [400], subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2019 The Bebas Neue Project Authors (https://github.com/dharmatype/Bebas-Neue)" },
  { name: "Playfair Display", slug: "playfair-display", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display)" },
  { name: "Nunito", slug: "nunito", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2014 The Nunito Project Authors (https://github.com/googlefonts/nunito)" },

  // ---- hyperframes parity (the @fontsource families it embeds) ---------------
  { name: "Archivo Black", slug: "archivo-black", variable: false, weights: [400], subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2017 The Archivo Black Project Authors (https://github.com/Omnibus-Type/ArchivoBlack)" },
  { name: "EB Garamond", slug: "eb-garamond", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2017 The EB Garamond Project Authors (https://github.com/octaviopardo/EBGaramond12)" },
  { name: "IBM Plex Mono", slug: "ibm-plex-mono", variable: false, weights: [400, 700], subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2017 IBM Corp. (https://github.com/IBM/plex)" },
  { name: "JetBrains Mono", slug: "jetbrains-mono", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)" },
  { name: "Lato", slug: "lato", variable: false, weights: [400, 700, 900], subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2010-2014 by tyPoland Lukasz Dziedzic (https://www.latofonts.com)" },
  { name: "League Gothic", slug: "league-gothic", variable: false, weights: [400], subset: "latin", license: "OFL-1.1",
    copyright: "Copyright The League of Moveable Type (https://github.com/theleagueof/league-gothic)" },
  { name: "Montserrat", slug: "montserrat", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2011 The Montserrat Project Authors (https://github.com/JulietaUla/Montserrat)" },
  { name: "Noto Sans JP", slug: "noto-sans-jp", variable: false, weights: [400, 700], subset: "japanese", license: "OFL-1.1",
    copyright: "Copyright 2014-2021 Google LLC (https://github.com/notofonts/noto-cjk)" },
  { name: "Open Sans", slug: "open-sans", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2020 The Open Sans Project Authors (https://github.com/googlefonts/opensans)" },
  { name: "Oswald", slug: "oswald", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2016 The Oswald Project Authors (https://github.com/googlefonts/OswaldFont)" },
  { name: "Outfit", slug: "outfit", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2021 The Outfit Project Authors (https://github.com/Outfitio/Outfit-Fonts)" },
  { name: "Poppins", slug: "poppins", variable: false, weights: [400, 700, 900], subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2020 The Poppins Project Authors (https://github.com/itfoundry/Poppins)" },
  { name: "Roboto", slug: "roboto", variable: true, subset: "latin", license: "Apache-2.0",
    copyright: "Copyright 2011 Google Inc. (https://github.com/googlefonts/roboto), Apache License 2.0" },
  { name: "Source Code Pro", slug: "source-code-pro", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2010-2019 Adobe (https://github.com/adobe-fonts/source-code-pro)" },
  { name: "Space Mono", slug: "space-mono", variable: false, weights: [400, 700], subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2016 The Space Mono Project Authors (https://github.com/googlefonts/spacemono)" },

  // ---- house-style faces (beyond hyperframes) --------------------------------
  { name: "Hanken Grotesk", slug: "hanken-grotesk", variable: true, subset: "latin", license: "OFL-1.1",
    copyright: "Copyright 2020 The Hanken Grotesk Project Authors (https://github.com/hanken-design/HankenGrotesk)" },
  { name: "Noto Serif SC", slug: "noto-serif-sc", variable: false, weights: [400, 700], subset: "chinese-simplified", license: "OFL-1.1",
    copyright: "Copyright 2017 Google LLC (https://github.com/notofonts/noto-cjk)" },
  { name: "Noto Sans SC", slug: "noto-sans-sc", variable: false, weights: [400, 700], subset: "chinese-simplified", license: "OFL-1.1",
    copyright: "Copyright 2014-2021 Google LLC (https://github.com/notofonts/noto-cjk)" },
];

// One entry per woff2 file: { family, file, url, weightDecl }.
function fileList(fam) {
  const pkg = fam.variable ? `@fontsource-variable/${fam.slug}` : `@fontsource/${fam.slug}`;
  if (fam.variable) {
    const file = `${fam.slug}-${fam.subset}-wght-normal.woff2`;
    return [{ family: fam, file, url: `${CDN}/${pkg}/files/${file}`, weightDecl: "100 900" }];
  }
  return fam.weights.map((w) => {
    const file = `${fam.slug}-${fam.subset}-${w}-normal.woff2`;
    return { family: fam, file, url: `${CDN}/${pkg}/files/${file}`, weightDecl: String(w) };
  });
}

const ALL_FILES = FAMILIES.flatMap(fileList);

function renderCss() {
  const header = `/* video-vob font kit — built by scripts/build-fonts.js; do not hand-edit.
   OFL/Apache-licensed, vendored under mcp/assets/fonts/ and symlinked into
   compose/fonts/ on every save. font-display: block ensures headless capture
   never paints fallback glyphs mid-render. Attribution: mcp/assets/fonts/LICENSES.md. */\n`;
  const blocks = ALL_FILES.map((f) =>
    `@font-face { font-family: "${f.family.name}"; src: url("./fonts/${f.file}") format("woff2"); font-weight: ${f.weightDecl}; font-style: normal; font-display: block; }`,
  );
  return header + blocks.join("\n") + "\n";
}

function renderLicenses() {
  const lines = FAMILIES.map((fam) => `- ${fam.name} — ${fam.license} — ${fam.copyright}`);
  return `# Font kit attribution

This kit is built by \`scripts/build-fonts.js\` from [@fontsource](https://fontsource.org)
packages. Each typeface is bundled under its own license (the full SIL Open Font
License 1.1 text is in \`OFL.txt\`; Roboto is under the Apache License 2.0, the same
license as this repository). Fonts are aggregated, not modified.

${lines.join("\n")}
`;
}

async function download(file, url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error(`suspiciously small (${buf.length}B) — ${url}`);
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  const cssOnly = process.argv.includes("--css-only");
  fs.mkdirSync(FONTS_DIR, { recursive: true });

  if (!cssOnly) {
    let total = 0;
    const failures = [];
    for (const f of ALL_FILES) {
      const dest = path.join(FONTS_DIR, f.file);
      try {
        const bytes = await download(f.file, f.url, dest);
        total += bytes;
        console.log(`  ok  ${(bytes / 1024).toFixed(0).padStart(5)} KiB  ${f.file}`);
      } catch (err) {
        failures.push({ file: f.file, error: String(err.message || err) });
        console.error(`  FAIL            ${f.file}: ${err.message || err}`);
      }
    }
    if (failures.length) {
      console.error(`\n${failures.length} download(s) failed — fonts.css NOT regenerated. Fix the manifest and re-run.`);
      process.exit(1);
    }
    // All downloads succeeded — the kit is now all-woff2; drop any stale .ttf
    // from the previous kit so nothing dangling is left behind.
    for (const entry of fs.readdirSync(FONTS_DIR)) {
      if (/\.ttf$/i.test(entry)) fs.rmSync(path.join(FONTS_DIR, entry), { force: true });
    }
    console.log(`\nDownloaded ${ALL_FILES.length} files, ${(total / 1024 / 1024).toFixed(1)} MiB total.`);
  }

  fs.writeFileSync(CSS_PATH, renderCss());
  fs.writeFileSync(path.join(FONTS_DIR, "LICENSES.md"), renderLicenses());
  console.log(`Wrote ${path.relative(process.cwd(), CSS_PATH)} (${ALL_FILES.length} @font-face rules across ${FAMILIES.length} families).`);
  console.log(`Wrote ${path.relative(process.cwd(), path.join(FONTS_DIR, "LICENSES.md"))}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
