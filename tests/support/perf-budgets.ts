/**
 * Whether the absolute per-frame timing budgets of the multi-target geometry decision (decision 9)
 * are enforced. They are defined against reference devices (a mainstream Windows laptop, a
 * mid-range Android tablet, a recent iPad), not shared CI runners, whose timings swing with load.
 *
 * By default the perf suites measure and print every number but gate only on invariants that do
 * not depend on machine speed (idle means no frames and no messages, pins track current geometry,
 * reports per frame stay bounded). `pnpm perf` sets `UIUX_PERF_BUDGETS=1` to enforce the budgets
 * too, on a machine that stands in for a reference device.
 */
export const ENFORCE_PERF_BUDGETS = process.env.UIUX_PERF_BUDGETS === '1'
