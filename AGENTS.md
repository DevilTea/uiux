# Repository guidance

- Keep this repository as the single public package `@deviltea/uiux`.
- Preserve the Nuxt SPA (`ssr: false`) and Nitro server runtime.
- Keep the CLI help and version commands honest; `uiux init --workspace <dir>` initializes a minimal current-schema Workspace and `uiux dev --workspace <dir>` starts the unified packaged Nitro server for one selected Workspace.
- `uiux migrate --workspace <dir> [--dry-run]` upgrades an older Workspace to the current schema, `schemaVersion` 4 (CLI-only; steps `uiux.v1-to-v2`, `uiux.v2-to-v3`, then `uiux.v3-to-v4`).
- `uiux member|token|invite|session ... --workspace <dir>` manage that Workspace's host-local roster under `$UIUX_HOME` (default `~/.uiux`), and `uiux access copy --from <old-dir> --workspace <dir>` copies another path's roster and host history there once. Every `/api/*` and `/mcp` request needs a credential; agents send `Authorization: Bearer <token>`. Tests and smoke runs must use a temporary `UIUX_HOME`.
- Do not introduce Workspace schemas, domain semantics, or external protocol contracts without an accepted architecture decision (defined under "Repository specification" below) and a scoped task.
- Do not edit `design/` canonical files directly; author canonical resources (Views, Workspace settings, Locales, UX Flows, Review threads, Assets) through domain-specific authoring operations (`create_view`, `update_view_spec`, `update_view_structure`, `update_workspace_settings`, `create_locale`, `update_locale`, `create_flow`, `update_flow`, review lifecycle tools, and asset authoring). The one exception (owner ruling 2026-10-05): the reference Adapter `design/adapters/reference.ts` is code and may be edited directly.
- Agents do not run `uiux dev` against `design/`: the first start on a host writes a Baseline Checkpoint into the repository, and only the owner's host commits one (owner ruling 2026-10-09, https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18832873). Stage only files you produced; never `git add -A` or `git add .`.
- Review anchors are `{ viewId, widgetId }` or `{ scope: "workspace" }` (product-wide feedback). Agents may fix their own Review messages with `edit_review_message` (until a later submission or resolution) and withdraw their own unanswered threads with `retract_review_thread`; resolving stays human-only in the Workbench.
- Use pnpm and Node 24.11 or later in the Node 24 line. Run `pnpm check` for the repository baseline.

## Repository specification (`.spec/`)

- `.spec/` (`@deviltea/spec-tool`, format v1) is the authority for UIUX behavioral requirements and external contracts: Stories, Features with their Rules, Contracts with their Clauses, and Scenarios. It is the repository's own specification, not UIUX product data; do not confuse it with the `design/` dogfood Workspace.
- GitHub Discussions #1–#10 are frozen: they keep the rationale and history of the decisions imported into `.spec/`, and are no longer the authority. Where a Discussion and `.spec/` disagree, `.spec/` wins.
- Decision flow: propose a change in a Discussion (a new comment or a new Discussion) → the owner (@DevilTea) explicitly accepts the proposal in that Discussion → a `.spec/` PR records it → implementation PRs cite the spec unit IDs they implement or change (UUIDs such as `01a1144e-50dd-…`; the former `R.x.y` import refs no longer resolve). An "accepted architecture decision" means exactly this: a merged `.spec/` change backed by a proposal the owner accepted in a Discussion.
- Change `.spec/` semantic content only through the `spec` CLI (`pnpm exec spec ...`, JSON request on stdin) or `createSpecClient` from `@deviltea/spec-tool`, always with the current `expectedRevision`. Never hand-edit frontmatter, Rule or Clause records, Scenario tags or steps. Markdown bodies and Gherkin `#` comments are noncanonical and carry only provenance and notes; edit them only while no `spec` process is running.
- `.spec/` is closed-world: add no files or directories other than the ones the tool writes. The tool's coordination files (`.spec-tool-v1.lock`, `.spec-tool-v1.readers`) are ignored in `.gitignore`.
- Commands that take no request (for example `workspace validate`, `graph export`) wait on stdin; run them with `</dev/null`. Run `pnpm spec:validate` after changes; `pnpm check` runs it too.
- Follow the shipped skills `node_modules/@deviltea/spec-tool/skills/maintain-spec-workspace/SKILL.md` for changes and `node_modules/@deviltea/spec-tool/skills/review-spec-workspace/SKILL.md` for read-only review.

### Authoring policies

- Clauses own every exact persisted or wire shape (paths, fields, formats) and every value set (event names and payload fields, lifetimes, file modes, limits, diagnostic codes, status codes). Diagnostic codes appear only in Clauses.
- Rules state behavior only and name the Contract or Clause instead of restating a value. Keep a Rule to about 45 words and one testable assertion; split a longer or compound Rule, and fold a Rule that adds nothing testable on its own into a neighbor.
- One owner per assertion: a fact appears once across Rules, Clauses and Feature summaries. A Feature summary describes the Feature's scope only.
- Provenance is per Rule and Clause, in the owner body's `## Rule sources` table (Discussion permalinks, owner rulings, `code@`/`doc@` citations pinned to one commit per change). Record unbuilt or partly built behavior in the owner body's `## Implementation gaps` list (`Not built` or `Partly built as of <commit>`, with its tracking issue).
- Scenarios use Spec Tool's restricted Gherkin in English (Given* → When+ → Then+, single-line steps) and show one observable behavior. They demonstrate only the Rules or Clauses whose assertion a step exercises (`demonstrates` is a specification relation, not a coverage claim). Their `#` comments record `Source:`, each `Test:` that exercises the behavior (file, line, title at a pinned commit), and `Status:`, which must agree with the Implementation gaps of the units they demonstrate.
- Write the glossary's domain nouns (`GLOSSARY_NOUNS` in `tests/support/i18n-allowlist.mjs`) capitalized, such as View, Variant, Widget, Review, Flow, Spec, Decision, Evidence, Handoff, Workspace, Locale, Asset, Adapter, Agent, Token and Checkpoint, in US spelling. A View's `feature` tag is product data that groups Views for display, unrelated to the Features of `.spec/`.
- Standing owner rulings: there is no HTTP Contract, and the RootShell `t` Method belongs to the Adapter Contract; `DESIGN.md` (visual spec) and the `design/` dogfood Workspace stay out of `.spec/`; `@deviltea/spec-tool` is pinned to an exact version and its skills are used from `node_modules`.

## Source layout

- `app/` contains the Nuxt SPA.
- `server/` contains Nitro routes.
- `src/server/` contains server helpers shared by routes and tests.
- `bin/` contains the executable CLI entrypoint.
