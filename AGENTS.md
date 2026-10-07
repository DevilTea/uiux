# Repository guidance

- Keep this repository as the single public package `@deviltea/uiux`.
- Preserve the Nuxt SPA (`ssr: false`) and Nitro server runtime.
- Keep the CLI help and version commands honest; `uiux init --workspace <dir>` initializes a minimal current-schema Workspace and `uiux dev --workspace <dir>` starts the unified packaged Nitro server for one selected Workspace.
- `uiux migrate --workspace <dir> [--dry-run]` upgrades an older Workspace to the current schema, `schemaVersion` 3 (CLI-only; steps `uiux.v1-to-v2` then `uiux.v2-to-v3`).
- `uiux publish --workspace <dir> --out <dir> [--base <path>] [--source-revision <rev>]` builds the read-only static publication of a Workspace (in a source checkout, run `pnpm build` first).
- `uiux member|token|invite|session ... --workspace <dir>` and `uiux access copy --from <old-dir> --workspace <dir>` manage that Workspace's host-local roster under `$UIUX_HOME` (default `~/.uiux`). Every `/api/*` and `/mcp` request needs a credential; agents send `Authorization: Bearer <token>`. Tests and smoke runs must use a temporary `UIUX_HOME`.
- Do not introduce Workspace schemas, domain semantics, or external protocol contracts without an accepted architecture decision and a scoped task.
- Do not edit `design/` canonical files directly; author canonical resources (Views, Workspace settings, Locales, UX Flows, Review threads, Assets) through domain-specific authoring operations (`create_view`, `update_view_spec`, `update_view_structure`, `update_workspace_settings`, `create_locale`, `update_locale`, `create_flow`, `update_flow`, review lifecycle tools, and asset authoring).
- Review anchors are `{ viewId, widgetId }` or `{ scope: "workspace" }` (product-wide feedback). Agents may fix their own Review messages with `edit_review_message` (until a later submission or resolution) and withdraw their own unanswered threads with `retract_review_thread`; resolving stays human-only in the Workbench.
- Use pnpm and Node 24.11 or later in the Node 24 line. Run `pnpm check` for the repository baseline.

## Repository specification (`.spec/`, transitional)

- TRANSITIONAL: `.spec/` (`@deviltea/spec-tool` frozen v1) is being populated from GitHub Discussions #1–#10 and the current repository. Until the cutover, the accepted decisions in those Discussions remain authoritative and `.spec/` is not; the cutover will be announced in this file.
- `.spec/` is the repository's own specification, not UIUX product data; do not confuse it with the `design/` dogfood Workspace.
- Change `.spec/` semantic content only through the `spec` CLI (`pnpm exec spec ...`, JSON request on stdin) or `createSpecClient` from `@deviltea/spec-tool`, always with the current `expectedRevision`. Never hand-edit frontmatter, Rule/Clause records, Scenario tags or steps. Markdown bodies and Gherkin `#` comments are noncanonical and only carry provenance and explanatory notes; edit them only while no `spec` process is running.
- `.spec/` is closed-world: do not add files or directories other than the ones the tool writes.
- Commands that take no request (for example `workspace validate`, `graph export`) wait on stdin; run them with `</dev/null`. Run `pnpm spec:validate` after changes; `pnpm check` runs it too.
- Import batches are applied with `node scripts/spec-import/apply.mjs <batch.json>`, which keeps the import ref-to-UUID map in `scripts/spec-import/refmap.json` (outside `.spec/`); that directory is temporary and is removed at the cutover.
- A batch overwrites the titles, summaries, Story fields, `motivates` targets, Rule and Clause statements, `constrains` targets and bodies of every unit it names, and a Feature or Contract that lists Rules or Clauses must list all of them in order; a batch deletes a folded or duplicate Rule or Clause by naming it in its `retired` list. Change an imported unit in its batch source (re-rendering the batch with `baseRevision` set to the current revision) or in a newer batch, never in `.spec/` alone, and never re-run an older batch after newer edits: the applier refuses a batch whose `baseRevision` is not the current revision unless the run is a no-op or `--force` is given (`--dry-run` lists every change it would refuse and exits 1).
- Rules and Clauses do not overlap: a Clause owns an exact persisted or wire shape (paths, fields, formats) and every value set (event names and payload fields, lifetimes, file modes, limits, diagnostic codes, status codes); a Rule states behavior and names the Contract or Clause instead of restating the value. Diagnostic codes appear only in Clauses.
- One owner per assertion: a fact appears once across Rules, Clauses and Feature summaries, and a Feature summary describes the Feature's scope only. Split a Rule longer than about 45 words or holding more than one testable assertion; fold a Rule that adds nothing testable on its own into a neighbor and retire it.
- The `code@` and `doc@` citations a batch adds or re-pins all use one baseline commit.
- Write the glossary's domain nouns (`GLOSSARY_NOUNS` in `tests/support/i18n-allowlist.mjs`) capitalized, such as View, Variant, Widget, Review, Flow, Spec, Decision, Evidence, Handoff, Workspace, Locale, Asset, Adapter, Agent and Token, in US spelling. A View's `feature` tag is product data that groups Views for display, unrelated to the Features of `.spec/`.
- Owner rulings on the import plan: there is no HTTP Contract, and the RootShell `t` Method is folded into the Adapter Contract (Q4); `DESIGN.md` (visual spec) and the `design/` dogfood Workspace stay out of `.spec/` (Q7); provenance is recorded per Rule and Clause in the owner body's `## Rule sources` table (Q9); `@deviltea/spec-tool` is pinned to an exact version (Q5) and its skills are used from `node_modules` (Q10).
- Follow the shipped skills `node_modules/@deviltea/spec-tool/skills/maintain-spec-workspace/SKILL.md` for changes and `node_modules/@deviltea/spec-tool/skills/review-spec-workspace/SKILL.md` for read-only review.

## Spec calibration (batches 1–3 checkpoint)

Calibration pass between batch 3 and batch 4; transitional — Discussions #1–#10 remain authoritative until cutover.

### Contract ownership

- **Batch 5 owns the shared Contracts:** `batch-05.json` names the full C.ws-format, C.mutation-semantics and C.mcp Contracts and the C.adapter and C.handoff-bundle Contracts it creates, so batches 02 to 04 can no longer be re-run; change those Contracts only through batch 05 (re-rendered against the current revision) or a newer batch that names them in full, and change a unit that only an older batch names through a newer batch that names it in full.

### Ownership and structure

- **Clauses own every wire format and value set:** Events, payloads, lifetimes, file modes, limits, diagnostic codes, status codes.
- **Rules state behavior** and reference Clauses; they do not restate value sets.
- **One owner per assertion:** A fact appears once across Rules, Clauses and Feature summaries; Feature summaries describe scope only.
- **Rule splitting:** Split Rules longer than approximately 45 words or holding more than one testable assertion; fold untestable Rules into neighbors and retire them.

### Import applier

- **Retired list:** `retired` array deletes Rules and Clauses; applier syncs the refmap.
- **Automatic reorder:** Applier reorders Rules and Clauses to match batch order.
- **Dry-run behavior:** `--dry-run` reports all planned changes and refusals for stale batches (exit 1) instead of throwing.

### Baseline and citations

- **One baseline commit per batch:** All `code@` and `doc@` citations for a batch use one commit.

### Glossary and style

- **Glossary nouns capitalized and US spelling:** View, Variant, Widget, Review, Flow, Spec, Decision, Evidence, Handoff, Workspace, Locale, Asset, Adapter, Agent, Token (in `GLOSSARY_NOUNS`, `tests/support/i18n-allowlist.mjs`).

### Notable changes in batches 1–3

- **Moved to Clauses:** SSE wire shape → C.mutation-semantics.change-events; lifetimes → C.access.lifetimes; store modes → C.access.store-modes; lease duration, roster intervals, system credentials, last-owner, stamp warnings, schema diagnostics, busy.
- **Moved to shared Clauses:** Host allowlists, safe methods, Sec-Fetch-Site values → C.access.
- **Moved to Clauses:** Migration step IDs → C.ws-format.migration-steps.
- **Retired:** R.publication.readiness-counts (moved to thread-free), R.view.variants.orthogonal (into render-context), R.view.authoring.name (duplicate; #56 gap moved to R.ws.layout.labels).
- **Fixes:** C.mutation-semantics.success includes `deleted` (retract_review_thread); `already_exists` → 409 stated; "409/423/403 only normative" scoped to mutation results (401/429 stay normative per Discussions #1, 421/403/415 per ruling B4, 422 per ruling B1, 503 per ruling B2).
- **Counts:** Rules 149→161 (+12), Clauses 91→105 (+14), nodes 308→334 (+26), edges 445→463 (+18).

## Source layout

- `app/` contains the Nuxt SPA.
- `server/` contains Nitro routes.
- `src/server/` contains server helpers shared by routes and tests.
- `bin/` contains the executable CLI entrypoint.
