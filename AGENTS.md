# Repository guidance

- Keep this repository as the single public package `@deviltea/uiux`.
- Preserve the Nuxt SPA (`ssr: false`) and Nitro server runtime.
- Keep the CLI help and version commands honest; `init` and `dev` remain placeholders until their product behavior is implemented.
- Do not introduce Workspace schemas, domain semantics, or external protocol contracts without an accepted architecture decision and a scoped task.
- Use pnpm and Node 24.11 or later in the Node 24 line. Run `pnpm check` for the repository baseline.

## Source layout

- `app/` contains the Nuxt SPA.
- `server/` contains Nitro routes.
- `src/server/` contains server helpers shared by routes and tests.
- `bin/` contains the executable CLI entrypoint.
