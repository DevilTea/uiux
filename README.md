# UIUX

[Live UIUX Spec](https://deviltea.github.io/uiux/) · read-only static publication of this repository's canonical `design/` Workspace

`@deviltea/uiux` is the single-package home for the UIUX local-first UI/UX specification, preview, and review workbench.

The package provides a Nuxt SPA and a unified Nitro server. `uiux init --workspace <dir>` creates a minimal current-schema file-native Workspace, and `uiux dev --workspace <dir>` explicitly selects one Workspace and starts the Workbench/API/MCP process against it.

## Requirements

- Node.js 24.11 or later in the Node 24 line
- pnpm 10.34.4

## Development

```sh
pnpm install
pnpm dev
```

For product use, initialize a Workspace once and then start the unified server:

```sh
uiux init --workspace ./design
uiux dev --workspace ./design
```

Nitro serves `GET /api/health`, selected-Workspace point reads under `/api/resources/:kind/:key`, discovery endpoints under `/api/resources/list` and `/api/resources/search`, safe binary asset content delivery under `/api/assets/:id/content`, authoring endpoints under `/api/*`, and MCP at `/mcp`. The Workbench lists canonical resources, displays their content and diagnostics, and refreshes from the same selected-Workspace application facade used by HTTP and MCP.

MCP exposes compact read-only discovery plus domain-specific authoring operations with revision CAS:
- Views: `create_view`, `update_view_spec`, `update_view_structure`
- Workspace settings: `update_workspace_settings`
- Locales: `create_locale`, `update_locale`
- UX Flows: `create_flow`, `update_flow`
- Reviews: `create_review_thread`, `append_review_message`, `reanchor_review_thread`, `set_review_display_hint`, `submit_ready_for_review`, `resolve_review_thread`, `reopen_review_thread`, `promote_review_to_decision`
- Authored Assets: `create_asset`, `replace_asset`

These are domain-specific operations rather than generic Resource writes or JSON Patch surfaces.

Resolving a Review thread is a human act performed in the Workbench (`POST /api/reviews/:id/resolve`). `resolve_review_thread` stays registered on `/mcp` but always refuses with guidance: agents reply on the thread or submit it ready for review. A resolution is `verified` (accepts the evidence-gated ready-for-review submission) or closes the thread without a verified change: `answered`, `wont-fix`, `duplicate` (requires a reason) or `obsolete`.

### Workspace schema migration

A Workspace records its format in `.uiux/workspace.json` `schemaVersion`. An older recognized Workspace opens read-only (`migration_required`) until it is migrated explicitly, from the command line only:

```sh
uiux migrate --workspace ./design --dry-run   # print the steps and changed files, write nothing
uiux migrate --workspace ./design             # apply atomically and print the new manifest revision
```

`uiux migrate` refuses while a running UIUX server holds the Workspace; stop `uiux dev` first. There is no MCP or HTTP migration entrypoint.

### Loopback-only access

The first version is single-user and unauthenticated, so `uiux dev` listens on loopback only: `127.0.0.1` by default, with the port taken from the standard Nitro `PORT` / `NITRO_PORT` variables (default `3000`). It prints the address it actually listens on. Setting `HOST` or `NITRO_HOST` to a loopback address (`127.0.0.1`, `::1` or `localhost`) is allowed; any other value makes `uiux dev` refuse to start, because LAN exposure requires authentication, which is not yet available.

Every request, including `/mcp`, `/api/*` and Workbench assets, must address the server as `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`; any other `Host` gets `421` (DNS-rebinding protection). State-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`), and every `/mcp` request, are refused with `403` when a browser marks them as cross-origin (`Origin` not equal to the server's own origin, or `Sec-Fetch-Site` other than `same-origin` / `none`). State-changing requests that carry a body must send `Content-Type: application/json` (otherwise `415`). Non-browser clients such as curl, scripts and MCP CLIs that send no `Origin` keep working. The server sends no CORS headers, and pages are served with `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so only the Workbench itself can frame them (as it does for `/preview`).

## Static publication

`uiux publish` materializes a selected Workspace as a portable, read-only interactive site. The published viewer does not require Nitro, MCP, filesystem access, or an API server at runtime; canonical resources, Preview adapter runtime, Assets, Formal Evidence artifacts, and the Workspace Handoff readiness assessment are captured at build time.

```sh
pnpm build
uiux publish --workspace ./design --out ./.pages --base /uiux/ --source-revision "$(git rev-parse HEAD)"
```

`--base` makes the generated shell safe for project subpaths such as GitHub Pages. Publication output carries a deterministic content identity plus optional source-revision provenance. Authoring controls are removed in published mode; View context switching, Preview, Inspector, UX Flows, review history, evidence inspection, and readiness remain interactive.

This repository dogfoods that command in the `Publish UIUX Spec` GitHub Actions workflow and deploys the result to [GitHub Pages](https://deviltea.github.io/uiux/).

## Dogfood Workspace

This repository keeps its own UIUX specification in `design/`. Initialize a new Workspace with `uiux init`; once a UIUX server is running against it, agents should author canonical resources through domain-specific MCP tools rather than editing files in `design/` directly. The Workbench is the human inspection surface for the same canonical state.

## Checks

```sh
pnpm check
```

This runs ESLint, Nuxt typechecking, Vitest, the production build, and a live Nitro health-route smoke check.

It also packs the public npm artifact from source, installs that tarball into an isolated temporary project, initializes a Workspace through the installed `uiux init`, starts it through `uiux dev --workspace <dir>`, and exercises the live HTTP/MCP selected-Workspace path.

The Playwright configuration is included as the future browser-test and capture baseline. Browser capture behavior is not implemented by this bootstrap.

## Domain contracts

Canonical Workspace resources and their validators live under `src/domain/`. The Widget executable IR remains Adapter/Widget-owned; UIUX validates only its reserved `RootShell` identity boundary. Application revision envelopes are separate from persisted resources, and Preview cross-iframe DTOs live under `src/preview/protocol/`. Workspace adapters are validated server-side by Node authority, and materialized on-demand into standalone browser bundles for the Preview iframe runtime mount without mixing Vue or widget module instances into the parent Nuxt Workbench.
