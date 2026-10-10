/**
 * Per-suite timeout for the heavy server-side suites (handoff closure, shared HTTP/MCP reads, review
 * resolution and hints). Each test builds a real file-native Workspace on disk and drives it end to
 * end: the packaged Nitro server spawned as a child process, MCP over real Streamable HTTP, adapter
 * bundling. Alone, the slowest test takes about 3 s; under the full `pnpm test` run, where the
 * Playwright suites load the machine at the same time, the same tests have exceeded Vitest's 5 s
 * default without being stuck.
 *
 * The global default stays 5 s so every other suite still fails fast; only these suites opt in, and
 * 20 s is several times the observed worst case, so a real hang still fails.
 *
 * The dogfood uiux.v3-to-v4 CLI replay test in `workspace-migration.test.ts` also uses it, per test.
 * That test runs the CLI three times as real child processes (each bundles its command with esbuild)
 * plus an fsynced migration transaction. It takes about 0.6 s alone and close to 4 s under CPU and
 * I/O load.
 *
 * `history-restore.test.ts` uses it too: each test starts a history recorder, writes Checkpoints and
 * fsynced host versions and restores through the full write path (one also assesses Handoff
 * readiness), taking 0.7 to 2.5 s alone and about 5.5 s for the readiness test.
 */
export const HEAVY_SERVER_SUITE_TIMEOUT_MS = 20_000
