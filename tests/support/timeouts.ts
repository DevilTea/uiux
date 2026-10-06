/**
 * Per-suite timeout for the heavy server-side suites (handoff closure, Static Publication snapshot,
 * shared HTTP/MCP reads, review resolution and hints). Each test builds a real file-native Workspace
 * on disk and drives it end to end: the packaged Nitro server spawned as a child process, MCP over
 * real Streamable HTTP, adapter bundling, publication materialization. Alone, the slowest test takes
 * about 3 s; under the full `pnpm test` run, where the Playwright suites load the machine at the
 * same time, the same tests have exceeded Vitest's 5 s default without being stuck.
 *
 * The global default stays 5 s so every other suite still fails fast; only these suites opt in, and
 * 20 s is several times the observed worst case, so a real hang still fails.
 */
export const HEAVY_SERVER_SUITE_TIMEOUT_MS = 20_000
