# Repository guidance

- Keep this repository as the single public package `@deviltea/uiux`.
- Preserve the Nuxt SPA (`ssr: false`) and Nitro server runtime.
- Keep the CLI help and version commands honest; `uiux init --workspace <dir>` initializes a minimal current-schema Workspace and `uiux dev --workspace <dir>` starts the unified packaged Nitro server for one selected Workspace.
- Do not introduce Workspace schemas, domain semantics, or external protocol contracts without an accepted architecture decision and a scoped task.
- Do not edit `design/` canonical files directly; author canonical resources (Views, Workspace settings, Locales, UX Flows, Review threads, Assets) through domain-specific authoring operations (`create_view`, `update_view_spec`, `update_view_structure`, `update_workspace_settings`, `create_locale`, `update_locale`, `create_flow`, `update_flow`, review lifecycle tools, and asset authoring).
- Use pnpm and Node 24.11 or later in the Node 24 line. Run `pnpm check` for the repository baseline.

## Source layout

- `app/` contains the Nuxt SPA.
- `server/` contains Nitro routes.
- `src/server/` contains server helpers shared by routes and tests.
- `bin/` contains the executable CLI entrypoint.
