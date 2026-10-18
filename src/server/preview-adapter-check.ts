import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { maskHostPaths } from '../adapters/host-paths'
import type { Diagnostic } from '../domain/validation'
import type { PreviewBundleResult } from './preview-bundler'

/**
 * - `valid`: the bundle ran and its Adapters passed every check.
 * - `invalid`: the bundle ran and reported a real mismatch, such as a Widget plugin from another
 *   widget-core copy; the Adapter set is invalid.
 * - `unchecked`: the bundle could not be evaluated in the server's worker (it needs a browser, or it
 *   did not report in time). The set is not made invalid: `warnings` says the server-side check could
 *   not run, and the Preview's own guard decides in the browser.
 */
export type PreviewAdapterCheck =
	| Readonly<{ state: 'valid' }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ state: 'unchecked'; warnings: readonly Diagnostic[] }>

type PreviewBundle = Pick<PreviewBundleResult, 'bundleJs'>

type WorkerReport =
	| Readonly<{ ok: true; reported: unknown }>
	| Readonly<{ ok: false; message: string; transient?: true }>

/**
 * How long the worker may take to evaluate a bundle and report before it is ended and the check
 * counts as not run. An implementation bound, not a specified value: a bundle whose top level keeps
 * a handle alive or awaits forever must not hold every request for it.
 */
export const PREVIEW_ADAPTER_CHECK_TIMEOUT_MS = 30_000

/** The worker's heap bound: a bundle that exhausts it ends the worker, and the check counts as not run. */
const WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 512 } as const

/**
 * Per built bundle, its check, so each bundle is checked once. A deterministic result is kept, among
 * them a failed evaluation (a bundle's content never changes, so evaluating it again would fail
 * again). A transient failure, a timeout or an exhausted worker heap, is dropped, so a later
 * request evaluates the bundle again.
 */
const checks = new WeakMap<PreviewBundle, Promise<PreviewAdapterCheck>>()

/**
 * Evaluates the bundle module given as a `data:` URL and posts what its
 * `describeAdapterDiagnostics()` reports. It runs in a worker thread, so the bundle evaluates with
 * globals of its own, as in a Preview document, not with those of the server, which has already
 * evaluated the Adapter modules once to resolve them.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
import(workerData.url).then(
  (module) => parentPort.postMessage({ ok: true, reported: typeof module.describeAdapterDiagnostics === 'function' ? module.describeAdapterDiagnostics() : undefined }),
  (error) => parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) }),
)
`

/**
 * The one server-side check of an Adapter set's runtime members (Clause
 * 01a116f0-cae2-7c64-9c76-d472f252789a, Discussion #241 R4): the Preview bundle is evaluated and
 * the checks its mount factory ran on the imported members are read back, among them whether each
 * Widget plugin was created by the host's `@deviltea/widget-core`. The bundle's own copy is the
 * host's, so a plugin from another copy (one inlined into a pre-built Adapter, which the bundler's
 * aliasing cannot reach) fails widget-core's inspection here exactly as it does in the browser.
 * Loading the manifest in Node cannot decide this: Node may resolve another widget-core copy for
 * the Workspace than the one the bundle uses.
 *
 * `getSelectedWorkspacePreviewBundle` applies the result, so the Product Kit page and the Preview's
 * Adapter check (`GET /api/preview/adapters`), the Preview bundle files, formal capture and the Flow
 * editor's Event read all report the same state, and a refused plugin is never loaded; Handoff
 * export applies it to the Adapters it materializes (`checkAdapterSetRuntime`). A bundle that cannot
 * be evaluated in Node leaves the set valid with a warning, and the Preview's browser guard decides
 * (owner decision during review of #248).
 */
export function checkPreviewBundleAdapters(
	bundle: PreviewBundle,
	workspaceRoot: string,
	options: Readonly<{ timeoutMs?: number }> = {},
): Promise<PreviewAdapterCheck> {
	let check = checks.get(bundle)
	if (!check) {
		const started: Promise<PreviewAdapterCheck> = runCheck(bundle, workspaceRoot, options.timeoutMs ?? PREVIEW_ADAPTER_CHECK_TIMEOUT_MS, () => {
			if (checks.get(bundle) === started) checks.delete(bundle)
		})
		check = started
		checks.set(bundle, check)
	}
	return check
}

async function runCheck(bundle: PreviewBundle, workspaceRoot: string, timeoutMs: number, onTransient: () => void): Promise<PreviewAdapterCheck> {
	const roots = async () => [resolve(workspaceRoot), await realpath(workspaceRoot).catch(() => resolve(workspaceRoot))]
	const report = await evaluateInWorker(bundle.bundleJs, timeoutMs)
	if (!report.ok && report.transient) onTransient()
	if (!report.ok) return unchecked(maskHostPaths(withoutBundleUrl(report.message), await roots()))
	const reported = report.reported
	if (!Array.isArray(reported) || !reported.every(isDiagnostic))
		return unchecked('the bundle did not report the checks of its Adapters.')
	if (reported.length === 0) return { state: 'valid' }
	const masked = await roots()
	return { state: 'invalid', diagnostics: frozen(reported.map(({ code, path, message }) => ({ code, path, message: maskHostPaths(message, masked) }))) }
}

/** An evaluation error may quote the module's URL, which is the whole bundle as `data:` base64. */
export function withoutBundleUrl(message: string): string {
	return message.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/gu, '<preview bundle>')
}

/**
 * Runs `WORKER_SOURCE` on the bundle. The worker is ended once it has reported, whatever the module
 * left running, or once `timeoutMs` passed without a report.
 */
function evaluateInWorker(bundleJs: string, timeoutMs: number): Promise<WorkerReport> {
	return new Promise((settle) => {
		const url = `data:text/javascript;base64,${Buffer.from(bundleJs, 'utf8').toString('base64')}`
		let done = false
		let worker: Worker
		try {
			worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { url }, resourceLimits: WORKER_RESOURCE_LIMITS })
		}
		catch (error) {
			settle({ ok: false, transient: true, message: error instanceof Error ? error.message : String(error) })
			return
		}
		const timer = setTimeout(() => finish({ ok: false, transient: true, message: `the evaluation did not report within ${timeoutMs} ms.` }), timeoutMs)
		timer.unref()
		function finish(report: WorkerReport): void {
			if (done) return
			done = true
			clearTimeout(timer)
			settle(report)
			void worker.terminate()
		}
		worker.once('message', (report: WorkerReport) => finish(report))
		worker.once('error', error => finish({
			ok: false,
			message: error instanceof Error ? error.message : String(error),
			...((error as { code?: unknown }).code === 'ERR_WORKER_OUT_OF_MEMORY' ? { transient: true as const } : {}),
		}))
		worker.once('exit', code => finish({ ok: false, message: `the evaluation ended (exit code ${code}) before it reported.` }))
	})
}

function unchecked(reason: string): PreviewAdapterCheck {
	return { state: 'unchecked', warnings: frozen([{
		code: 'preview.bundle_failed',
		path: '/product-kit',
		message: `The server could not run the Adapter check on the Preview bundle, so the Preview checks the Adapters when it loads: ${reason}`,
	}]) }
}

function frozen(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
	return Object.freeze(diagnostics.map(item => Object.freeze({ ...item })))
}

function isDiagnostic(value: unknown): value is Diagnostic {
	return !!value && typeof value === 'object'
		&& typeof (value as Diagnostic).code === 'string'
		&& typeof (value as Diagnostic).path === 'string'
		&& typeof (value as Diagnostic).message === 'string'
}
