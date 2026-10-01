# UIUX

`@deviltea/uiux` is the single-package home for the UIUX local-first UI/UX specification, preview, and review workbench.

The bootstrap currently provides a Nuxt SPA, a Nitro health endpoint, and the `uiux --help` / `uiux --version` CLI surface. Workspace initialization and the unified development command are not implemented yet.

## Requirements

- Node.js 24.11 or later in the Node 24 line
- pnpm 10.34.4

## Development

```sh
pnpm install
pnpm dev
```

The Nuxt SPA runs at `http://127.0.0.1:3000`. Nitro also serves `GET /api/health`, which returns `{ "status": "ok" }`.

## Checks

```sh
pnpm check
```

This runs ESLint, Nuxt typechecking, Vitest, the production build, and a live Nitro health-route smoke check.

It also packs the public npm artifact from source, installs that tarball into an isolated temporary project, verifies the installed `uiux` CLI, starts the packed Nitro runtime, and probes `GET /api/health`.

The Playwright configuration is included as the future browser-test and capture baseline. Browser capture behavior is not implemented by this bootstrap.

## Domain contracts

Canonical Workspace resources and their validators live under `src/domain/`. The Widget executable IR remains Adapter/Widget-owned; UIUX validates only its reserved `RootShell` identity boundary. Application revision envelopes are separate from persisted resources, and Preview cross-iframe DTOs live under `src/preview/protocol/`.
