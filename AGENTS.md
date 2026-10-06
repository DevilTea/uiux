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
- Follow the shipped skills `node_modules/@deviltea/spec-tool/skills/maintain-spec-workspace/SKILL.md` for changes and `node_modules/@deviltea/spec-tool/skills/review-spec-workspace/SKILL.md` for read-only review.

## Source layout

- `app/` contains the Nuxt SPA.
- `server/` contains Nitro routes.
- `src/server/` contains server helpers shared by routes and tests.
- `bin/` contains the executable CLI entrypoint.
