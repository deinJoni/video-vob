# PRD: Platform distribution metadata as a typed PLAN layer surfaced at PACKAGE + import

## 1. Summary

The storyboarder already produces the *content* of a post — the cut, the captions, the look — but the human still hand-writes the title, description, hashtags, and CTA when they upload. This PRD adds a loosely-shaped, optional `target.distribution{title,description,hashtags[],cta}` storyboard layer that mirrors `target.design` exactly: validated unconditionally (any schema version), never linted, never gated. On `--like`, the metadata is re-mirrored by the storyboarder *agent* at the skill layer the same way it re-mirrors `target.design` — there is **no engine code that copies the `target` block**; `state.style` (`mcp/lib/session-state.js:55-56`) is only an advisory `{derived_from, applied_at}` pointer that no gate reads (see §4.5). At PACKAGE it folds into `manifest.json` as a `distribution` block (including a `chapters_paste_block` reusing the existing chapter stamps) and a `## Distribution` README section with fenced copy-paste blocks. The same block is mirrored into the fan-out / import-only path (`deliverables/manifest.json`) — because multi-short social fan-out is *precisely* the multi-platform-distribution case (one cut, N re-typed titles per platform). Per-platform caps (hashtag counts, description-length hints) are deferred to a fast-follow; v1 is a pure, validated passthrough with zero `platform-profiles.js` edits.

## 2. Problem & motivation

The packaged output today carries everything an editor needs except the metadata that actually gets the video posted. `vob_package_output` writes a rich `manifest.json` (`mcp/lib/tools/package-output.js:345-413`) and a human-readable README (`mcp/lib/package-readme.js:35-168`) covering output dims, thumbnail, audio loudness, chapters, source, lineage, render — but there is **no field for the post copy** (title/description/hashtags/CTA). The storyboard schema already proves the pattern for "structured creative metadata the composer/packager reads but the engine never enforces": `target.design` is validated by `validateDesign` (`mcp/lib/storyboard-schema.js:305-327`) at an unconditional, non-version-gated call site (`storyboard-schema.js:849-850`), and `target.fps` rides the same way (`storyboard-schema.js:844-847`). Distribution metadata is the same class of data and has no home.

Two concrete gaps:

- **Single-timeline projects:** the editor finishes a cut, opens `package/README.md`, and finds no title/description to paste into the upload form. For a chaptered long-form video the chapter stamps *are* in the README (`package-readme.js:87-98`) but disconnected from a paste-ready description body.
- **Fan-out / import-only projects:** `vob_import_deliverable` regenerates `deliverables/manifest.json` (`mcp/lib/tools/import-deliverable.js:352-360`) — the package manifest for multi-short projects, since `vob_package_output` refuses fan-out outright (`package-output.js:153-160`). This manifest carries the deliverable set but **no distribution copy**, even though a fan-out of N shorts to N platforms is the canonical case where each short needs its own re-typed title and hashtags. The feature would miss the projects that need it most.

The storyboarder agent can author this metadata from brief + tone + key_moments + target_platform with exactly the kind of write it already does for `target.design` — but the engine offers no validated slot to write into and no surface to render it from.

## 3. Goals / Non-goals

**Goals**

- Add an optional, loosely-shaped `target.distribution{title,description,hashtags[],cta}` to the storyboard schema, validated unconditionally (any schema version, no version gate), that **never lints** and has **no QC binding / no gate / no version flag** — mirroring `validateDesign` byte-for-byte in spirit.
- At PACKAGE, read distribution **from the on-disk storyboard** (`sbForGuard.target.distribution`, exactly like `chaptersFromStoryboard(sbForGuard)`), and fold it into a manifest `distribution` block + a `## Distribution` README section with fenced copy-paste blocks.
- Include a `chapters_paste_block` in the distribution block (a single newline-joined string of `youtube_stamp title` lines), gated on `chaptersFromStoryboard` returning non-null so a 30s social short never emits an empty/3-required block.
- Mirror the distribution block into `import-deliverable.js`'s `deliverables/manifest.json` regen, closing the fan-out / import-only gap.
- On `--like`, distribution copy is re-mirrored by the storyboarder agent (skill layer) verbatim alongside `target.design`, with zero new engine logic (see §4.5) — `state.style` stays an advisory pointer, not a copy mechanism.
- Land the manifest key + README section as their own small commit to minimize merge surface against the concurrent phase-1–7 refactors.

**Non-goals (deferred, with reasons)**

- **Per-platform caps / validation** (hashtag-count limits, description-length hints, title truncation). `platform-profiles.js` has **no** such fields today; adding them is a separate data-modeling exercise. v1 is a pure passthrough — *deferred* to keep this PRD free of any `platform-profiles.js` edit (a hot file other phases may touch). The storyboarder is the right place to apply platform conventions when it authors the copy; the engine doesn't enforce them.
- **Linting distribution content** (empty title, missing CTA, hashtag format). Like `target.design`, distribution is advisory creative copy — *deliberately never linted*, so the storyboarder can grow the tone table without a schema edit and a sparse social short doesn't get warned for omitting a description.
- **A new tool or a new gate.** This is an additive validator + additive manifest/README emission. No `ALLOWED_TRANSITIONS`/`GATES` edit, no tool registration, no `allowed-tools`/`permissions.allow`/`opencode.json` change.
- **Per-platform variant fan-out of distribution copy from one storyboard** (e.g. auto-deriving a TikTok caption and a YouTube description from one source). The storyboarder authors per-short copy under each short's timeline if needed; multi-aspect / per-platform automated variants stay out of scope (consistent with "posters + multi-aspect variants stay package-only").
- **Reading distribution from `state.target`.** `state.target` is the canonicalized INTENT block; `target.fps`/`design`/`distribution` live **only** in `storyboard.json`. This PRD reads from disk, never from `state.target`.

## 4. Design

### 4.1 Data shape (storyboard `target.distribution`)

A new optional object on `target`, all fields optional, mirroring `target.design`:

```json
"target": {
  "platform": "youtube_long",
  "duration_seconds": 10,
  "tone": "calm documentary",
  "design": { "...": "..." },
  "distribution": {
    "title": "How We Cut This in One Take",
    "description": "A short doc on the edit.\n\nShot on a DJI Pocket.",
    "hashtags": ["#filmmaking", "#oneTake", "#editing"],
    "cta": "Subscribe for the next teardown."
  }
}
```

Loose shape contract (validated by a new `validateDistribution`, mirroring `validateDesign` at `storyboard-schema.js:305-327`):

- `title`, `description`, `cta` — non-empty strings when present (each independently optional).
- `hashtags` — array of non-empty strings when present.
- Object-shape error when `distribution` itself is not a plain object.
- No enum, no length cap, no required field. Every field optional, same as `validateDesign`.

The `distribution` field does **not exist anywhere in the current schema** (confirmed) — net-new, no collision with the existing `target` keys.

### 4.2 Validation hook (storyboard-schema.js)

Add `validateDistribution(distribution, errors, where = "target.distribution")` next to `validateDesign` (after `storyboard-schema.js:327`). Add one unconditional call inside the `target`-is-object branch (the `} else {` branch spanning `:832-852`), immediately after the existing `validateDesign` call at `:850` and before the branch's closing brace at `:852`:

```
// storyboard-schema.js, at line 851 — after the validateDesign call (:850),
// before the closing brace of the isPlainObject(input.target) else-branch (:852)
if (input.target.distribution !== undefined && input.target.distribution !== null) {
  validateDistribution(input.target.distribution, errors);
}
```

No `schema_version` gate (matches `target.design` and `target.fps`). No document-global uniqueness pass (unlike overlay/caption ids — distribution has no ids). Plain `{text,...}` storyboards stay valid forever.

### 4.3 PACKAGE emission (package-output.js + package-readme.js)

The single-timeline path already reads the on-disk storyboard into `sbForGuard` (`package-output.js:143-148`) and derives `chapters = chaptersFromStoryboard(sbForGuard)` (`package-output.js:340`). `chaptersFromStoryboard` returns **null** for any non-segmented storyboard (it gates on `storyboardHasSegments` in `storyboard-schema.js`), so a single-timeline schema-1.0 project has no chapters and therefore no paste block. Add a sibling derivation:

1. A module-private layering in `package-output.js` (next to `chaptersFromStoryboard`, `package-output.js:107-125`) over the exported `distributionFromStoryboard(sb)` normalizer (§4.4):
   - Reads `sb.target.distribution`; returns `null` when absent/not-a-plain-object (so the manifest key is conditionally spread, additive, no `manifest_version` bump).
   - Normalizes: `title`/`description`/`cta` → string-or-null; `hashtags` → array of non-empty strings (or `[]`); also a convenience `hashtags_line` = `hashtags.join(" ")` (or `null` when empty) for one-paste use.
   - `chapters_paste_block`: **only** when `chapters` (the array `chaptersFromStoryboard` returned) is non-null AND non-empty — built as `chapters.map(c => \`${c.youtube_stamp} ${c.title}\`).join("\n")`. This reuses the exact `youtube_stamp` + `title` shape already on each chapter object (`package-output.js:115-121`). When `chapters === null` (e.g. a 30s social short with no `segments[]`), `chapters_paste_block` is omitted from the block — a non-chaptered video never emits an empty block, and the "≥3 entries / first at 0:00" YouTube rule is never half-satisfied.
   - Returns `null` only when distribution is entirely absent; otherwise returns the normalized block even if some fields are null (so an editor sees which fields the storyboarder filled).

2. In the manifest object literal (`package-output.js:345-413`), add the distribution key following the **canonical additive key order** the four package-touching PRDs share — `chapters, captions, distribution, posters, video, aspect_variants` — so the conditional-spread diffs stack rather than collide. Distribution lands after the existing `...(chapters ? { chapters } : {})` line (`package-output.js:354`) and after any `captions` spread (PRD 1), before `posters`/`video`/`aspect_variants`:

```
...(distribution ? { distribution } : {}),
```

   `manifest_version` stays `"1.2"` (additive key — consistent with the sibling PRDs, none of which bump it; the conditional spreads are order-independent so semantics compose, but the fixed key order keeps the merge mechanical).

The manifest `distribution` block shape (when present):

```json
"distribution": {
  "title": "How We Cut This in One Take",
  "description": "A short doc on the edit.\n\nShot on a DJI Pocket.",
  "hashtags": ["#filmmaking", "#oneTake", "#editing"],
  "hashtags_line": "#filmmaking #oneTake #editing",
  "cta": "Subscribe for the next teardown.",
  "chapters_paste_block": "0:00 The Setup\n0:05 The Payoff"
}
```

3. README section in `package-readme.js`. Insert per the **canonical section order** shared by the four package-README PRDs: Posters goes after `## Thumbnail` (`:67`); then `## Captions`, `## Distribution`, `## Aspect variants` go after `## Chapters` (`:98`) in that order, before `## Target` (`:100`). This distribution section is therefore the **second** of the post-Chapters insertions (after Captions, before Aspect variants), guarded by `if (manifest.distribution && typeof manifest.distribution === "object")`. Each present field renders as a fenced copy-paste block so an editor can select-and-copy cleanly:

```markdown
## Distribution

**Title**

​```
How We Cut This in One Take
​```

**Description**

​```
A short doc on the edit.

Shot on a DJI Pocket.

0:00 The Setup
0:05 The Payoff
​```

**Hashtags**

​```
#filmmaking #oneTake #editing
​```

**Call to action**

​```
Subscribe for the next teardown.
​```
```

   - The description fence appends the `chapters_paste_block` (a blank line then the stamps) **only when** `chapters_paste_block` is present — so a YouTube long-form description is one paste with chapters inline, and a social short's description has no trailing stamp noise.
   - Each sub-block is omitted when its field is null/empty (mirrors how `package-readme.js` omits the Audio/Chapters sections conditionally). An entirely-empty distribution object renders no sub-blocks (but the `## Distribution` header is only printed when at least one field is present — guard on a computed `hasAnyField`).

### 4.4 Fan-out / import-only mirror (import-deliverable.js)

`import-deliverable.js` already reads the storyboard via `readStoryboardSafe(id)` (`import-deliverable.js:70-77`, called at `:112`). Reuse that `storyboard` value (already in scope inside `importDeliverable`). The import-side mirror touches two regions also touched by PRD 1 (the per-deliverable caption mirror); the two are **distinct sinks** and must be serialized (PRD 1's per-record `record.captions` inside the materialize loop `:273-324`; this PRD's top-level `manifest.distribution` in the regen literal `:352-360`). Inside the locked manifest regen (`import-deliverable.js:352-360`), derive the same normalized block and conditionally spread it:

```
...(distribution ? { distribution } : {}),
```

into the `deliverables/manifest.json` object. To avoid duplicating the normalizer, **extract the normalizer into `storyboard-schema.js`** as an exported pure helper `distributionFromStoryboard(sb)` (chapters-agnostic core: title/description/hashtags/hashtags_line/cta) and have `package-output.js` layer the `chapters_paste_block` on top of it (chapters are a single-timeline / segmented concept; fan-out shorts have no document-level `segments[]`, so the deliverables manifest carries the chapters-free block). This keeps one source of truth for the field normalization and keeps the chapter coupling in the one place that has chapters. (PRD 1's caption mirror uses a different helper — `findTimeline(item.short_id)`, which it must add to the `:20` `require` destructure; this PRD adds only `distributionFromStoryboard` there.)

`deliverables/manifest.json` `manifest_version` stays `"1.0"` (additive; no internal consumer distinguishes).

### 4.5 `--like` (no code change)

`--like` style inheritance stamps `state.style = {derived_from, applied_at}` (`mcp/lib/session-state.js:55-56`) — an **advisory pointer only**: no gate reads it, and there is **no engine code that copies the source `target` block** (or any of its sub-fields) into the new storyboard. The actual look propagation happens at the skill layer: the orchestrator hands the composer the source `compose/` + brief as a look reference, and the storyboarder agent, when it re-authors the new project's storyboard, re-mirrors the resolved look into `target.design` (and now `target.distribution`) from the source storyboard it reads. Because `target.distribution` lives in the same validated `target` object the storyboarder already re-mirrors the look from, it rides along verbatim with **zero new engine logic** — exactly as `target.design` does. The only behavioral note is skill-layer (§5, deferred): the storyboarder agent prompt should be told distribution is copy-verbatim-on-`--like`, same as design.

## 5. Seam-level change list

| File | Anchor | Change |
|---|---|---|
| `mcp/lib/storyboard-schema.js` | after `validateDesign` (ends `:327`) | **NEW** `validateDistribution(distribution, errors, where="target.distribution")` — object-shape check; `title`/`description`/`cta` non-empty-string-when-present; `hashtags` array-of-non-empty-strings-when-present. All optional. |
| `mcp/lib/storyboard-schema.js` | at `:851` (after the `validateDesign` call `:850`, before the `isPlainObject(input.target)` else-branch closing brace `:852`) | **NEW** unconditional call: `if (input.target.distribution != null) validateDistribution(...)`. No version gate. |
| `mcp/lib/storyboard-schema.js` | near `collectBrollGaps` / module exports | **NEW** exported pure helper `distributionFromStoryboard(sb)` → normalized `{title,description,hashtags,hashtags_line,cta}` or `null`. Add to `module.exports`. |
| `mcp/lib/tools/package-output.js` | after `chaptersFromStoryboard` (`:125`) | **NEW** module-private layering: derive base via `distributionFromStoryboard(sbForGuard)`, attach `chapters_paste_block` when `chapters` (`:340`) is non-null & non-empty. |
| `mcp/lib/tools/package-output.js` | manifest literal, canonical key order `chapters, captions, distribution, posters, video, aspect_variants` — after `...(chapters ? { chapters } : {})` (`:354`) / after `captions`, before `posters` | **NEW** `...(distribution ? { distribution } : {})`. `manifest_version` unchanged (`"1.2"`). |
| `mcp/lib/tools/package-output.js` | import block (`:29`) | Add `distributionFromStoryboard` to the `require("../storyboard-schema.js")` destructure. |
| `mcp/lib/tools/package-output.js` | tool `description` (`:460`) | Append one clause: "…+ a distribution block (title/description/hashtags/cta + chapters paste-block) when the storyboard declares `target.distribution`." (description string only — not a schema/registry change). |
| `mcp/lib/package-readme.js` | between Chapters (`:98`) and Target (`:100`), canonical order: Captions → **Distribution** → Aspect variants | **NEW** `## Distribution` section: per-field fenced copy-paste blocks; header printed only when ≥1 field present; description fence appends `chapters_paste_block` when present. |
| `mcp/lib/tools/import-deliverable.js` | import block (`:20`) | Add `distributionFromStoryboard` to the `require("../storyboard-schema.js")` destructure (distinct from PRD 1's `findTimeline` add to the same destructure). |
| `mcp/lib/tools/import-deliverable.js` | manifest regen literal (`:353-360`) | **NEW** `...(distribution ? { distribution } : {})` using `distributionFromStoryboard(storyboard)` (the already-read `storyboard`, `:112`). `manifest_version` unchanged (`"1.0"`). Serialize with PRD 1's per-record caption edit (adjacent, distinct sink). |
| `scripts/m5-walker.js` | `storyboard()` fixture `target` (`:252-...`), `package` phase manifest assert (`:2482`) | Add `distribution` to the single-timeline fixture; assert manifest + README (see §8). |
| `scripts/m5-walker.js` | `lfSb.target` (`:1481`), longform PACKAGE assert (`:1636-1648`) | Add `distribution` to the longform fixture; assert `chapters_paste_block` present + README Distribution section. |
| `scripts/m5-walker.js` | `fanoutStoryboard()` `target`, import asserts (`:864`) | Add `distribution` to the fan-out fixture; assert `deliverables/manifest.json` carries `distribution` with **no** `chapters_paste_block`. |

**No new state keys.** **No new schema-version.** **No `paths.js` additions** (distribution lives inside existing `storyboard.json` / `manifest.json` / `deliverables/manifest.json`). **No `manifest_version` bump** (both `"1.2"` and `"1.0"` unchanged — additive conditional-spread keys). **No tool registration / allow-list / `opencode.json` change** (no new tool, no new arg on an existing tool's `inputSchema`).

## 6. Invariants preserved

- **package_output refusals fire BEFORE the package/ wipe.** Both the fan-out refusal (`package-output.js:153-160`) and the unassembled-segmented refusal (`package-output.js:166-184`) are untouched and remain strictly before the wipe (`:224-227`). All new distribution work is the `distributionFromStoryboard` derivation (a pure read of `sbForGuard`, already loaded at `:143`) and the conditional manifest spread — both land **after** the refusals, alongside the existing `chapters` derivation at `:340`. A refused project never loses its prior package.
- **package/ fully wiped + regenerated each run.** The distribution block is derived fresh from the on-disk storyboard and written into the freshly-regenerated `manifest.json`/`README.md` on every run; nothing is appended. No stale distribution can survive a re-package.
- **deliverables/ is session-level, never under package/.** No change to `deliverablesDir` or the package wipe scope; the import-side mirror writes into the existing `deliverables/manifest.json` (`import-deliverable.js:352`), which the package wipe never reaches.
- **import merge identity unchanged.** The distribution block is a top-level manifest field derived from the storyboard, fully orthogonal to `deliverableKey` / record identity (`import-deliverable.js:86-90`); the `byKey` merge, `-n` suffixing, and id-from-post-dedup-filename logic are untouched.
- **Back-edge auto-archival untouched.** No new artifact path, no new state slot; archival (`archival.js`) moves `renders/`+`package/` exactly as before. The next package run re-derives distribution from the (copied) storyboard.
- **state.json/manifest.json/brief.md written only by vob_\* tools.** All writes stay inside `vob_package_output` / `vob_import_deliverable` handlers via the existing `writeFileAtomic` calls (`package-output.js:415-416`, `import-deliverable.js:353`); no new writer, no hand-write.
- **FSM never skips forward; no edge change.** No `ALLOWED_TRANSITIONS` / `GATES` edit, no new blocker — distribution touches neither an edge nor a precondition. It is pure validation + emission.
- **Gates re-check disk.** Unaffected — no gate reads distribution. PACKAGE reads `sbForGuard` from disk (`fs.readFileSync`, `:145`), consistent with the disk-is-truth principle; nothing trusts a state summary.
- **`validateDesign` mirroring (loosely shape-checked, never lints, non-version-gated).** `validateDistribution` is a structural validator in the same function family, called at the same unconditional site, contributing to the same `errors[]` that rejects a malformed *shape* at save — it never participates in plan-lint (the content-quality pass) and never gates a transition, exactly like `validateDesign`.
- **5 required intent keys never renamed.** Untouched — distribution is a storyboard `target` field, not an intent key.
- **additivity via conditional-spread, no manifest_version bump.** Both emissions use `...(distribution ? { distribution } : {})`, the sanctioned additive pattern; neither manifest's version is bumped because no internal consumer must distinguish old-vs-new (the README renderer and any reader handle the key's absence gracefully).

## 7. Data dependencies & availability

- **Upstream producer:** `target.distribution` is authored by the storyboarder agent (skill layer) — the same kind of write it already does for `target.design`. **Confirmed present as a pattern:** the storyboarder mirrors the resolved look into `target.design` today (`summarizeActiveVideoType` surfaces `design_default`, `video-types.js:462-477`; the agent writes `target.design`, validated at `storyboard-schema.js:849-850`). The new field is opt-in: if the storyboarder writes nothing, the validator accepts it (all-optional) and PACKAGE/import emit no `distribution` block (conditional spread → key absent). **No hard dependency** — the engine half is independently correct and walker-verifiable with hand-authored fixtures.
- **Chapters source (for `chapters_paste_block`):** `chaptersFromStoryboard(sbForGuard)` (`package-output.js:107-125`), already computed at `:340`, returns the `youtube_stamp`+`title` array or `null` (it gates on `storyboardHasSegments` and so returns null for every non-segmented storyboard). **Confirmed present.** The paste block reuses this exact array and is gated on non-null; no new chapter computation. For fan-out (`deliverables/manifest.json`), there are no document-level `segments[]` (segments are mutually exclusive with shorts[], `storyboard-schema.js:610-613`), so the deliverables manifest correctly carries a chapters-free distribution block.
- **On-disk storyboard read:** both handlers already read `storyboard.json` (`package-output.js:143-148` → `sbForGuard`; `import-deliverable.js:70-77,112` → `storyboard`). **Confirmed present** — no new read, no new path builder. Reading from `state.target` is explicitly avoided (canonicalized INTENT block, lacks `target.fps`/`design`/`distribution`).
- **README renderer input:** `renderPackageReadme(manifest)` already receives the full manifest object (`package-output.js:416`); the new `## Distribution` section reads `manifest.distribution`. **Confirmed present** via the manifest it's handed.

## 8. Verification

Add assertions to three existing `scripts/m5-walker.js` phases (no new phase). Run: `node scripts/m5-walker.js package`, `node scripts/m5-walker.js longform`, `node scripts/m5-walker.js fanout` (and `all`).

**`package` phase (single-timeline, schema 1.0, no chapters):**
- In the `storyboard()` fixture (`:247-...`), add to `target`: `distribution: { title: "Walker Cut Title", description: "Body line one.", hashtags: ["#walker", "#vob"], cta: "Follow for more." }`.
- After `vob_package_output` (`:2482`), read `pkg.manifest_path`:
  - `assert(manifest.distribution && manifest.distribution.title === "Walker Cut Title")`.
  - `assert(manifest.distribution.hashtags_line === "#walker #vob")`.
  - `assert(!("chapters_paste_block" in manifest.distribution))` — the schema-1.0 fixture has no `segments[]`, so `chaptersFromStoryboard` returns null and a non-chaptered short emits **no** paste block (the gating requirement).
- Read `pkg.readme_path`: `assert(/## Distribution/.test(readme) && /Walker Cut Title/.test(readme) && /#walker #vob/.test(readme))`.

**`longform` phase (schema 1.2, segments → chapters):**
- In `lfSb.target` (`:1481`), add `distribution: { title: "Longform Title", description: "Doc body.", hashtags: ["#doc"], cta: "Subscribe." }`.
- At the existing PACKAGE assert block (`:1636-1648`), read the manifest:
  - `assert(manifest.distribution.chapters_paste_block === "0:00 The Setup\n0:05 The Payoff")` — paste block reuses the exact chapter stamps already asserted at `:1639`.
- README: `assert(/## Distribution/.test(readme))` and that the description fence contains `0:00 The Setup` (chapters inlined into the pasteable description).

**`fanout` phase (shorts[], import path):**
- In `fanoutStoryboard()` `target`, add a `distribution` block.
- At the first import assert block (`:854-866`), read `imp1.deliverables_manifest_path`:
  - `assert(dm.distribution && dm.distribution.title === <expected>)`.
  - `assert(!("chapters_paste_block" in dm.distribution))` — fan-out has no document-level segments, so no chapter block.

**Negative shape check (any phase, cheap):** a `vob_save_storyboard` with `target.distribution.hashtags: "not-an-array"` must reject (the existing `expectError` helper, `:66`) with the validation error from `validateDistribution`, proving the unconditional shape gate.

**Manual check:** open a real `package/README.md` after a hand-authored distribution block; confirm each fenced block selects cleanly (no stray indentation, code fences balanced) and the YouTube long-form description fence has chapters inlined.

## 9. Parallel-safety & sequencing

**Collision risk is low and localized.** This PRD is additive in every seam: a new validator function, one new validation call, one new exported normalizer, two conditional-spread manifest keys, one README section, three walker fixture/assert additions. No edge, no gate, no tool registry, no allow-list, no `paths.js`, no `manifest_version` bump — so the wide-seam drift guard (`verifyAdapterToolReferences`) and the FSM two-file rule are entirely untouched.

**Hot shared files (watch for line-adjacency with sibling phase 1–7 work):**
- `mcp/lib/storyboard-schema.js` — the single highest-collision file. `validateDistribution` slots after `validateDesign` (`:327`) and the call at `:851` (after the `validateDesign` call at `:850`). If a concurrent PLAN-layer PRD is editing the same validator region or the `validateStoryboard` `target` branch, expect a trivial textual conflict (two functions / two adjacent calls), resolvable by keeping both. Mitigate by landing `validateDistribution` + its call as the **first** small commit. (PRD 6's `TARGET_LAYERS` constant lands in `archival.js` per its own spec — **not** here — so it does not add a second collision in this file.)
- `mcp/lib/tools/package-output.js` — the SINGLE hottest file in the Wave-A batch: PRDs 1 (captions), 2 (posters), 3 (this one), 5 (aspect variants) all edit the manifest literal (`:345-413`), the package state slot (`:421-430`), the history files count (`:438`), and `session_artifacts_written` (`:476`). These cannot be developed on the same lines in parallel. **Recommended serial order on a shared package branch:** PRD 2 (posters, cheapest, no deps) → PRD 3 (this) → PRD 1 (captions) → PRD 5 (aspect variants). Each rebases the manifest/slot/README edits onto the prior. The fixed manifest key order (`chapters, captions, distribution, posters, video, aspect_variants`) and the fixed README section order (Posters after Thumbnail; Captions → Distribution → Aspect variants after Chapters) make the rebases mechanical — conditional-spread keys are order-independent, so semantics compose regardless of land order. Package-state-slot and `summarizePackage` (`session-state.js:489-501`) additions must be ordered **identically in both files**.
- `mcp/lib/package-readme.js` — the section sequence in `renderPackageReadme`. Three post-Chapters insertions (PRD 1 Captions, this PRD Distribution, PRD 5 Aspect variants) plus PRD 2's Posters-after-Thumbnail target the `:67`/`:98-100` anchors; the canonical order above resolves the otherwise-identical insertion point. This PRD inserts Distribution second of the three post-Chapters sections.
- `mcp/lib/tools/import-deliverable.js` — the `require` destructure (`:20`) and the manifest regen literal (`:353-360`). PRD 1 also edits the materialize loop here (`:273-324`, per-record caption mirror) and adds `findTimeline` to the same `:20` destructure; this PRD adds `distributionFromStoryboard` there and the top-level `distribution` spread in the regen. Distinct sinks, adjacent edits — serialize with PRD 1's import-side change.
- `scripts/m5-walker.js` — fixtures + asserts in three phases; additive, low conflict.

**Sequencing / dependencies:**
- **No dependency on sibling PRDs.** This PRD stands alone; it does not consume any output of the other Wave-A PRDs and produces no key they need. In particular, it does **not** read `manifest.captions` anywhere — its `chapters_paste_block` reuses `chaptersFromStoryboard`, not captions — so there is **no PRD 1 → PRD 3 dependency** (a previously-stated "captions is foundational" coupling does not exist on the package side; the two are independent and merely co-located in the import materialize loop). The FAN-OUT MIRROR decision lists distribution among the import-mirrored fields, so this PRD *owns* the distribution half of that mirror; loudness (`normalize:true`, `import-deliverable.js:286-297`) already exists and needs no change.
- **Recommended commit boundaries (two commits, per the "small commit" directive):**
  1. **Validator commit:** `validateDistribution` + the unconditional call + the exported `distributionFromStoryboard` normalizer in `storyboard-schema.js`, plus the negative-shape walker assert. Self-contained, lands first to minimize the storyboard-schema merge window.
  2. **Emission commit:** the `package-output.js` + `package-readme.js` + `import-deliverable.js` manifest/README wiring + the three positive walker asserts. Depends only on commit 1's exported normalizer; rebases onto PRD 2's package edits per the serial order above.
- **Land before** any sibling PRD that rewrites the `validateStoryboard` `target` branch wholesale (to avoid re-deriving the call-site), if such a refactor is in this batch; otherwise order is free.
