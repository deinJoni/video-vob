# PRD: Multi-aspect dumb-crop escape hatch (opt-in, labeled lossy)

## 1. Summary
   `vob_package_output` gains one optional `aspect_variants` arg (e.g. `["1:1","16:9"]`). On a single-timeline package, after the existing in-place loudnorm of `final.mp4`, each requested aspect is canonicalized to a `platform-profiles.js` geometry and a pure-ffmpeg scale+crop/pad pass writes `package/variants/<aspect>.mp4` — copying the already-normalized audio (`-c:a copy`, no second loudnorm pass). Variants are recorded in a new manifest `aspect_variants[]` block, each flagged `quality:"naive_crop"`, with a README warning that center-crop may clip captions/subjects. It never runs by default, never fires on a fan-out project (those route through `import-deliverable` and won't get variants — stated explicitly, not silently), and a single failed variant is downgraded to a warning so the package always completes. This is the honest, cheap "I just need a 1:1 too" lever; it is deliberately NOT a faithful reframe.

## 2. Problem & motivation
   Today `vob_package_output` emits exactly one `final.mp4` at the composition's baked geometry (`mcp/lib/tools/package-output.js:229,235` copies `render.mp4_path` into `packageFinalMp4Path` and never re-derives dimensions). A creator who shot a 9:16 short and also wants a 1:1 feed cut or a 16:9 landscape version has no in-engine path short of a full second project. The composition's `data-width`/`data-height` and CSS safe-bands are baked per-render (the storyboard `target` block is document-global — there is no per-aspect target), so a faithful multi-aspect output is a composer round-trip, which is heavy and out of scope for "I just need another aspect ratio to post." There is no escape hatch for the lossy-but-fine center-crop that every social tool offers. The platform geometry needed to do the crop already exists and is the single source of truth (`platform-profiles.js:14-93`, `getPlatformProfile`/`canonicalizePlatform` at `:215,198`) — it is simply never consulted at PACKAGE.

## 3. Goals / Non-goals
   **Goals**
   - Accept optional `aspect_variants: string[]` on `vob_package_output`; when present and non-empty, produce one cropped/padded MP4 per requested aspect under `package/variants/`.
   - Canonicalize every requested aspect to a real `platform-profiles.js` geometry; reject an unknown aspect with `INVALID_ARGUMENTS` (before any package work).
   - Reuse the already-loudnorm'd `final.mp4` as the single source: video re-encode + scale/crop/pad, `-c:a copy`. Never re-run `normalizeLoudnessInPlace` per variant.
   - Record each variant in manifest `aspect_variants[]` with `quality:"naive_crop"` + a README warning. Surface variants in the state slot and the lean return; bump the `package_built` history `files` count.
   - Fail soft: each variant in its own `try/catch` → push a warning + continue; never `cleanupOnFailure`; a failed variant never aborts the package.
   - Opt-in only — zero behavior change when the arg is absent.

   **Non-goals (and why)**
   - **Faithful reframe.** A real reframe re-lays-out captions/subjects for the new aspect; that requires a composer round-trip producing a *second* `compose/` and a per-short/per-segment `target{platform,fps}` schema addition (today the storyboard `target` block is document-global). Explicitly out of scope. The honest faithful path today is **N separate projects via `--like`** — say so in the README so the limitation isn't silent.
   - **Fan-out variants.** Multi-short fan-out routes finished work through `import-deliverable`, not `package_output` (which refuses fan-out at `package-output.js:153-160`). Variants are **single-timeline only**. We do NOT touch `import-deliverable.js` — variants are package-scoped derived artifacts, not deliverables.
   - **Per-variant loudness.** Dropped deliberately to avoid N extra passes and a write-conflict with any concurrent per-platform-loudness work. `loudnorm.js` is NOT in this PRD's seam set.
   - **Smart/content-aware cropping (face/subject tracking).** This is the *dumb*-crop hatch; the `naive_crop` flag and README warning own that limitation.

## 4. Design
   **Where it hooks.** Entirely inside `packageOutput` (`package-output.js:133`), strictly AFTER both pre-wipe refusals (fan-out `:138-160`, segmented `:162-184`), the precondition checks (`:186-221`), the package wipe (`:223-227`), the `final.mp4` copy (`:235`), and the in-place loudnorm + authoritative re-probe (`:255-264`). The variant loop is inserted **after the loudnorm/re-probe block and before the manifest is assembled** (i.e. after `:264`, before `:266`). It runs only when `aspect_variants` is present and non-empty.

   **Arg validation (early, before any package work — preserves the refusal-before-wipe invariant).** Immediately after `readSessionStateStrict` (`:136`) — placed **before the fan-out/segmented refusals AND before the wipe** so a bad arg throws `INVALID_ARGUMENTS` while every prior package on disk is still intact — validate the arg shape and canonicalize each requested aspect. The canonical aspect→profile resolution (all seams verified):
   - Accept the request strings as platform/aspect tokens and run each through `canonicalizePlatform` (`platform-profiles.js:198`), then `getPlatformProfile` (`:215`) to obtain `{width,height,aspect}`. The alias table resolves the standard aspects 1:1 (verified `:108-110`): `"1:1"`/`"square"`→`square` (1080×1080, `:109`), `"16:9"`/`"landscape"`→`landscape` (1920×1080, `:108`), `"9:16"`/`"vertical"`→`vertical` (1080×1920, `:110`).
   - **Reject unknown aspects by inspecting `recognized` (not by catching a throw).** `canonicalizePlatform` **never throws** (`:198` — it normalizes and falls through); an unrecognized token falls back to `canonical:"vertical"` with `recognized:false` (`:211`). So the validator MUST inspect the returned `recognized` flag: if `false`, throw `ToolError(INVALID_ARGUMENTS, ...)`. This is the correct discriminator for INVALID_ARGUMENTS precisely *because* the function silently coerces rather than signalling a bad token — relying on a throw would never fire. To keep the hatch tight, restrict accepted tokens to a small allowlist of aspect labels (`"1:1"`,`"16:9"`,`"9:16"`,`"4:5"` if a profile exists, plus the canonical platform names that map to them); anything else → `INVALID_ARGUMENTS`. (`"4:5"` correctly has **no profile today**, so it rejects until one is added to `render-profiles.json` — that is the intended override path; the alias table at `:108-110` has no `4:5` entry, confirming the rejection.)
   - De-dupe canonical targets, and skip a target whose `{width,height}` equals the source `final.mp4` dims (a no-op crop) — record it as a `skipped` variant rather than re-encoding an identical file.

   **The crop algorithm (per variant, pure ffmpeg).** Given source dims `Ws×Hs` (from the post-loudnorm `summary.primary_video`) and target `Wt×Ht`:
   - **Default = center-crop (cover):** scale to cover then crop to exact target —
     `-vf "scale=Wt:Ht:force_original_aspect_ratio=increase,crop=Wt:Ht"`.
   - This is the labeled-lossy behavior (`quality:"naive_crop"`): center-crop discards edges, which is what may clip captions/subjects. (Pad/letterbox is the non-lossy alternative; the PRD ships center-crop as the single documented mode to match "dumb-crop." A future `mode:"pad"` is a trivial extension but not in scope.)
   - Audio: `-c:a copy` (the source audio is already the −14 LUFS normalized track). Video: `-c:v libx264 -pix_fmt yuv420p` (+ default quality; no `-crf` tuning needed for an escape hatch). `-y` overwrite, output to `variantPath`.
   - Run via `runFfmpegBlocking` (`ffmpeg-runner.js:84`) with `{ cwd: pkgRoot }`, same pattern as the thumbnail extract (`package-output.js:270-280`).

   **Per-variant isolation + probe (mirrors the poster PRD's isolation pattern).** Each variant runs inside its own `try/catch` — the **same non-fatal per-artifact isolation pattern PRD 2 (posters) uses**, and the two loops compose cleanly if they land together because both rely on the identical contract: an artifact-local `try/catch` that pushes a warning and `continue`s, and **neither ever calls `cleanupOnFailure` (`:127`)**:
   - On `timed_out`, non-zero `exit_code`, or missing output file → push `{ aspect, error }` into a local `variantWarnings[]` and **`continue`** — NEVER `cleanupOnFailure(pkgRoot)` (that helper at `:127` wipes the whole package; a failed variant must not destroy the package, exactly as a failed poster must not).
   - On success → `probeFile(variantPath)` + `summarizeProbe` (`ffprobe.js:277`) for the recorded dims/size; push a survivor record. A probe failure on a survivor also degrades to a warning (do not throw).
   - The directory `package/variants/` is created (`fs.mkdirSync(variantsDir,{recursive:true})`) lazily, only when at least one variant will be attempted.

   **Manifest shape (additive, conditional-spread; manifest_version stays "1.2"; fixed key order vs. siblings).** Insert into the `manifest` object literal (`package-output.js:345-413`), gated by `...(aspectVariants.length ? {...} : {})`. To let the four package-touching PRDs (1 captions, 2 posters, 3 distribution, 5 aspect_variants) stack their diffs without churn, all four authors land their conditional-spread keys in **one fixed key order: `chapters, captions, distribution, posters, video, aspect_variants`**. This PRD's `aspect_variants` therefore lands **after the `video` block** (last of the six). Conditional spreads are order-independent semantically, so this is purely to make the diffs stack:
   ```jsonc
   "aspect_variants": [
     {
       "aspect": "1:1",
       "canonical_platform": "square",
       "path": "variants/1x1.mp4",          // session-relative-to-package, like "final.mp4"
       "width": 1080,
       "height": 1080,
       "duration_seconds": 21.4,
       "file_size_bytes": 4823104,
       "quality": "naive_crop",
       "source_aspect": "9:16",
       "source_dimensions": { "width": 1080, "height": 1920 }
     }
   ],
   "aspect_variant_warnings": [             // present only if any variant failed/skipped
     { "aspect": "16:9", "error": "ffmpeg exit 1: ..." }
   ]
   ```
   The filename uses a colon-safe slug (`1:1`→`1x1.mp4`, `16:9`→`16x9.mp4`) — never a colon in a path. `manifest_version` is NOT bumped (stays `"1.2"`, consistent with the other three package PRDs): no internal consumer must distinguish a manifest with vs. without `aspect_variants` (additive-key rule).

   **README (`package-readme.js`) — canonical section order resolves the 4-way insertion collision.** The verified README layout is: Output `:48`, Thumbnail `:56-67`, Audio `:70-82`, Chapters `:87-98`, Target `:100`. Four sibling PRDs insert sections around `## Chapters`/`## Target`; left uncoordinated they textually conflict at the identical `:98-100` anchor. **Canonical order (all four authors cite this same sequence):**
   - PRD 2 `## Posters` inserts **after `## Thumbnail` (after `:67`)**.
   - Then, inserted **between `## Chapters` (ends `:98`) and `## Target` (`:100`), in this fixed order:** PRD 1 `## Captions`, PRD 3 `## Distribution`, **then this PRD's `## Aspect variants`** (last of the three).
   This PRD therefore adds `## Aspect variants` **immediately before `## Target` (`:100`), after any Captions/Distribution sections**, rendered only when `manifest.aspect_variants?.length`. For each variant: list `path`, dims, and the literal warning line: *"Center-crop only (`naive_crop`) — edges are discarded, which may clip captions or subjects. For a faithful re-frame, create a separate project with `--like <this project>` and the target platform."* Also state: *"Aspect variants are single-timeline only; multi-short fan-out projects don't produce them."* If `aspect_variant_warnings` is present, list the failed aspects.

   **State slot + lean return (fixed field order vs. siblings).** In the `package` slot (`package-output.js:421-430`) and `summarizePackage` (`session-state.js:489-501`), three sibling PRDs append fields (PRD 1 `captions_*_path`, PRD 2 `posters_dir`/`posters_count`, PRD 5 `variants[]`). All three append-only to the **same two regions**; order the additions **identically in both files** (PRD 1 captions, PRD 2 posters, PRD 5 `variants` — `variants` last). This PRD adds `variants: [...]` as **session-relative** paths (e.g. `package/variants/1x1.mp4` via `sessionRelative`) to both the slot and the lean return (`:446-454`). The `package_built` history event (`:434-441`) `files: 4` becomes `files: 4 + <survivor variant count>`.

   **Data flow summary:** `final.mp4` (loudnorm'd) → for each canonical aspect → ffmpeg scale+crop with `-c:a copy` → `package/variants/<slug>.mp4` → probe → manifest `aspect_variants[]` + README + state slot. No state read/write outside the existing `withSessionLock` block at `:418`.

## 5. Seam-level change list
   | File | Anchor | Change |
   |---|---|---|
   | `mcp/lib/tools/package-output.js` | `inputSchema` `:461-467` | Add `aspect_variants: { type:"array", items:{ type:"string" } }` to `properties` (NOT in `required`). **Mandatory** — validator defaults `additionalProperties:false`; an undeclared optional arg is rejected (the `save_classification` bug). |
   | `mcp/lib/tools/package-output.js` | after `:136` (before fan-out/segmented refusals + wipe) | New `resolveAspectVariants(args.aspect_variants)` helper call: validate array-of-strings, canonicalize each via `canonicalizePlatform` (`:198`)/`getPlatformProfile` (`:215`), reject any `recognized:false` (`:211`) or non-allowlisted token with `ToolError(INVALID_ARGUMENTS,...)`, de-dupe. Placed before the fan-out refusal so a bad arg never reaches the wipe. |
   | `mcp/lib/tools/package-output.js` | new helper near `:127` | `buildAspectVariant({ finalMp4, variantPath, target, sourceVideo })` — runs the ffmpeg scale+crop, returns `{ ok, record?, error? }`; never throws on ffmpeg failure, never calls `cleanupOnFailure` (`:127`). Plus `aspectSlug(aspect)` (`1:1`→`1x1`). |
   | `mcp/lib/tools/package-output.js` | after `:264` (post-loudnorm/re-probe) | Variant loop: skip no-op dims; `mkdirSync(variantsDir)`; per-variant `try/catch`→`buildAspectVariant`→probe survivor or push warning+`continue`; collect `aspectVariantRecords[]` + `variantWarnings[]`. (Same isolation shape as the poster loop — composes if both land.) |
   | `mcp/lib/tools/package-output.js` | `manifest` literal `:345-413`, after the `video` block | `...(aspectVariantRecords.length ? { aspect_variants: aspectVariantRecords } : {})` and `...(variantWarnings.length ? { aspect_variant_warnings: variantWarnings } : {})`, landed in the agreed key order `chapters, captions, distribution, posters, video, aspect_variants` (these two last). `manifest_version` unchanged (`"1.2"`). |
   | `mcp/lib/tools/package-output.js` | `package` slot `:421-430` + return `:446-454` | Add `variants: aspectVariantRecords.map(...)` (slot = session-relative; return = absolute, matching the `directory_path`/`final_mp4_path` convention at `:447-449`). Appended last after any sibling captions/posters fields. |
   | `mcp/lib/session-state.js` | `summarizePackage` `:489-501` | Add `variants` (session-relative), appended last in the same order as the slot (after any captions/posters fields). |
   | `mcp/lib/tools/package-output.js` | history event `:434-441` | `files: 4 + aspectVariantRecords.length`. |
   | `mcp/lib/tools/package-output.js` | metadata `:476` | Append `"package/variants/"` to `session_artifacts_written`. |
   | `mcp/lib/tools/package-output.js` | `description` `:460` | Append: opt-in `aspect_variants` produces labeled-lossy center-crop variants under `package/variants/`; single-timeline only. |
   | `mcp/lib/paths.js` | after `packageReadmePath` `:341` | NEW `packageVariantsDir(projectId)` → `path.join(packageDir(projectId),"variants")`. Optionally `packageVariantPath(projectId, slug)`. Export in the module list (`:402-407`). |
   | `mcp/lib/package-readme.js` | **immediately before `## Target` (`:100`), after any `## Captions`/`## Distribution` sections** | NEW `## Aspect variants` block, rendered only when `manifest.aspect_variants?.length`; includes the `naive_crop` warning, the `--like` faithful-path note, the single-timeline note, and any `aspect_variant_warnings`. (Canonical README order: Posters after Thumbnail; Captions, Distribution, Aspect variants after Chapters in that order.) |
   | `scripts/m5-walker.js` | `package` phase `:2482` | Pass `aspect_variants:["1:1","16:9"]`; assert manifest block + files on disk + state slot (see §8). |

   **New state keys:** `state.package.variants[]` (session-relative strings).
   **New manifest keys:** `aspect_variants[]`, `aspect_variant_warnings[]` (conditional). No `manifest_version` bump.
   **No new tool, no FSM edge, no gate change, no adapter allow-list / `port-adapter-docs.js` run** — this is an optional arg on an existing tool; the `verifyAdapterToolReferences` boot guard tracks tool *names*, not arg schemas. **`loudnorm.js` is NOT touched.** **`import-deliverable.js` is NOT touched.**

## 6. Invariants preserved
   - **Pre-wipe refusals come first, package never lost on refusal.** Arg validation throws `INVALID_ARGUMENTS` *before* the fan-out (`:138-160`) and segmented (`:162-184`) refusals and *before* the wipe (`:223`) — this ordering is the punch-list-confirmed correct placement, preserving the refusal-before-wipe invariant. All variant *work* is strictly after the wipe + loudnorm. A fan-out / segmented / bad-arg project still refuses before touching `package/` — a refused project keeps its prior package.
   - **`package/` fully rebuilt every run.** `variants/` is created fresh under `pkgRoot` *after* the `:223-227` wipe, so it is regenerated every successful run with the rest of the package — never appended/stale.
   - **`deliverables/` never reached by the wipe.** Untouched: variants live under `package/`, not `deliverables/`. No change to `deliverablesDir` (`paths.js:347`) or the wipe scope.
   - **import-deliverable merge identity untouched.** `import-deliverable.js` is not modified; fan-out routing and its `short:<id>` / `id:<stem>` identity are unaffected. Variants are explicitly fan-out-excluded.
   - **Back-edge auto-archive intact.** No new FSM edge; `archival.js` moves all of `package/` (variants included) into `archive/v<N>/` on a back-edge exactly as before — a prior cut's variants are preserved with it.
   - **`state.json`/`manifest.json` written only by `vob_*` tools.** All writes stay inside the existing `withSessionLock`/`writeFileAtomic` block (`:418-444`) and the pre-lock `writeFileAtomic` for manifest/README (`:415-416`). No hand-writes.
   - **FSM never skips forward; gates re-check disk.** No `ALLOWED_TRANSITIONS`/`GATES` edit (no edge added). PACKAGE behavior and the `renderToPackage` gate are unchanged; variants are produced *within* an already-legal package run.
   - **Two-tier override unaffected.** No new blocker; no gate touched.
   - **5 required intent keys unchanged.** Not touched.
   - **Manifest additive-key discipline.** `aspect_variants`/`aspect_variant_warnings` are conditional-spread; `manifest_version` stays `"1.2"` (no consumer must distinguish), consistent with the captions/posters/distribution siblings.
   - **No new npm deps.** Pure-ffmpeg via the existing `runFfmpegBlocking`; pure Node stdlib elsewhere.

## 7. Data dependencies & availability
   - **Source video + post-loudnorm dims** — confirmed present: `final.mp4` exists after `:235`, the authoritative `summary` (incl. `summary.primary_video.{width,height}`) is computed post-loudnorm at `:251`/`:257-264`. The variant loop consumes `summary.primary_video` for source dims and the no-op skip.
   - **Target geometry** — confirmed present: `getPlatformProfile` (`:215`)/`canonicalizePlatform` (`:198`) return `{width,height,aspect}` for all standard aspects; `square`/`landscape`/`vertical` aliased at `:108-110` (1:1→square 1080×1080, 16:9→landscape 1920×1080, 9:16→vertical 1080×1920). User `render-profiles.json` overrides extend the set (e.g. add `4:5`) with no code change.
   - **ffmpeg availability** — confirmed re-checked live at `:208-221` before any package work; `runFfmpegBlocking` is the same chokepoint the thumbnail already uses (`:270`).
   - **No blocked dependency.** Everything the feature reads already exists at the insertion point.

## 8. Verification
   Extend the **`package`** walker phase (`scripts/m5-walker.js:2480-2497`). Change the call at `:2482-2484` to pass `aspect_variants:["1:1","16:9"]`, then add assertions:
   - `pkg.variants` (lean return) is an array of length 2 (the synthetic walker source is 9:16, so neither target is a no-op).
   - Both `package/variants/1x1.mp4` and `package/variants/16x9.mp4` exist on disk (`fs.existsSync`).
   - Parse `manifest.json`: `manifest.aspect_variants` length 2; each has `quality === "naive_crop"`; the `1:1` entry has `width === 1080 && height === 1080`, the `16:9` entry `width === 1920 && height === 1080`; `manifest.manifest_version === "1.2"` (unchanged).
   - `ffprobe`/`summarizeProbe` each variant → assert actual decoded dims match the manifest dims (proves the crop ran, not just a copy).
   - README contains `## Aspect variants` and the `naive_crop` warning substring and the `--like` note, and (when siblings are present) appears *after* any `## Captions`/`## Distribution` and *before* `## Target`.
   - `read_state_summary` → `package.variants` length 2, session-relative paths.
   - **Negative-path assertions:** (a) `expectError("vob_package_output", { ..., aspect_variants:["banana"] }, /INVALID_ARGUMENTS/)` — drives the `recognized:false` (`:211`) rejection path — and assert `package/` from a prior successful run is untouched (refusal precedes wipe). (b) **Fan-out exclusion:** confirm the existing fanout-guard test at `:870-871` still throws `STATE_CONFLICT` even when `aspect_variants` is passed (variants never reach a fan-out project).
   - **Manual check:** run `node scripts/m5-walker.js package` and eyeball the two variant MP4s open at the expected aspect; confirm the package phase still reaches ITERATE.

## 9. Parallel-safety & sequencing
   - **Parallel-safe with siblings 4/6/7.** Opt-in, package-scoped, no shared-helper mutation. `loudnorm.js`, `import-deliverable.js`, `archival.js`, `phase-gates.js`, `session-state.js` transitionPhase (the FSM heart) are **not** touched. (This PRD's only `session-state.js` edit is the append to `summarizePackage` `:489-501` — disjoint from the `transitionPhase`/`buildStateSummary` regions PRDs 6/7 edit.)
   - **Hot shared file — `package-output.js` (PRDs 1, 2, 3, 5).** These four edit the same regions: the manifest literal (`:345-413`), the package state slot (`:421-430`), the history `files` count (`:438`), and `session_artifacts_written` (`:476`). They **cannot** be developed on the same lines in parallel; serialize on a shared package branch. **Recommended serial order: PRD 2 (posters, cheapest, no deps) → PRD 3 (distribution) → PRD 1 (captions) → PRD 5 (this PRD, lowest priority).** This PRD rebases its manifest/slot/README/summary edits onto the prior three, landing its keys/sections last in the agreed orders (manifest: `…video, aspect_variants`; README: `…Distribution, Aspect variants`; slot+summary: `…posters, variants`).
   - **`package-readme.js`** — additive `## Aspect variants` section, last of the after-Chapters trio (Captions, Distribution, Aspect variants), inserted before `## Target` (`:100`). Merge-orderable with the poster/captions/distribution sections per the canonical order in §4.
   - **`session-state.js` `summarizePackage`** — additive `variants` field, ordered after sibling captions/posters fields (matching the slot order).
   - **`paths.js`** — additive `packageVariantsDir`; pure addition to the export list.
   - **`m5-walker.js` `package` phase** — additive assertions.
   - **No cross-PRD data dependency.** This feature needs only the post-loudnorm `final.mp4`, which exists in `package_output` today; it does not consume any sibling PRD's output (no read of `manifest.captions`/`manifest.posters`/`manifest.distribution`). If a per-platform-loudness PRD lands first, the variant loop already keys off the post-loudnorm `summary` (`:257-264`), so the rebase is mechanical — confirm the insertion point is still *after* the final re-probe.
   - **Recommended boundary:** one branch/commit — `paths.js` + `package-output.js` + `package-readme.js` + `session-state.js` (`summarizePackage`) + walker assertions together (the walker is the de-facto test and must land green with the feature). No adapter-doc regeneration needed.
