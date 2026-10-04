# UIUX

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
- Reviews: `create_review_thread`, `append_review_message`, `reanchor_review_thread`, `submit_ready_for_review`, `resolve_review_thread`, `reopen_review_thread`, `promote_review_to_decision`
- Authored Assets: `create_asset`, `replace_asset`

These are domain-specific operations rather than generic Resource writes or JSON Patch surfaces. Host/port selection remains the standard Nitro runtime concern rather than a separate UIUX Workspace contract.

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
