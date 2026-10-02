# UIUX

`@deviltea/uiux` is the single-package home for the UIUX local-first UI/UX specification, preview, and review workbench.

The package provides a Nuxt SPA and a unified Nitro server. `uiux dev --workspace <dir>` explicitly selects one file-native Workspace and starts the Workbench/API/MCP process against it. Workspace initialization is not implemented yet.

## Requirements

- Node.js 24.11 or later in the Node 24 line
- pnpm 10.34.4

## Development

```sh
pnpm install
pnpm dev
```

For product use, start the unified server with:

```sh
uiux dev --workspace ./design
```

Nitro serves `GET /api/health`, selected-Workspace point reads under `/api/resources/:kind/:key`, discovery endpoints under `/api/resources/list` and `/api/resources/search`, and MCP at `/mcp`. Host/port selection remains the standard Nitro runtime concern rather than a separate UIUX Workspace contract.

## Checks

```sh
pnpm check
```

This runs ESLint, Nuxt typechecking, Vitest, the production build, and a live Nitro health-route smoke check.

It also packs the public npm artifact from source, installs that tarball into an isolated temporary project, starts the installed package through `uiux dev --workspace <dir>`, and probes both the health endpoint and selected-Workspace API behavior.

The Playwright configuration is included as the future browser-test and capture baseline. Browser capture behavior is not implemented by this bootstrap.

## Domain contracts

Canonical Workspace resources and their validators live under `src/domain/`. The Widget executable IR remains Adapter/Widget-owned; UIUX validates only its reserved `RootShell` identity boundary. Application revision envelopes are separate from persisted resources, and Preview cross-iframe DTOs live under `src/preview/protocol/`.
