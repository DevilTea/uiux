import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'

import { maskHostPaths } from '../adapters/host-paths'
import type { Diagnostic } from '../domain/validation'
import type { PreviewBundleResult } from './preview-bundler'

/** What the server reads from an evaluated Preview bundle module (the entry `preview-bundler.ts` generates). */
export type PreviewBundleModule = Readonly<{
	describeDeclaredWidgetEvents?: () => unknown
	describeAdapterDiagnostics?: () => unknown
}>

export type PreviewAdapterCheck =
	| Readonly<{ state: 'valid' }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>

type PreviewBundle = Pick<PreviewBundleResult, 'bundleJs'>

/** Per built bundle: its evaluated module and its check, so each runs once per bundle. */
const modules = new WeakMap<PreviewBundle, Promise<PreviewBundleModule>>()
const checks = new WeakMap<PreviewBundle, Promise<PreviewAdapterCheck>>()

/**
 * The Preview bundle's module, evaluated in this process once per built bundle. The bundle carries
 * the host's single widget-core copy (the bundler aliases it), so what the module reports about the
 * Adapters' members is what the Preview reports in the browser.
 */
export function evaluatePreviewBundle(bundle: PreviewBundle): Promise<PreviewBundleModule> {
	let evaluated = modules.get(bundle)
	if (!evaluated) {
		const url = `data:text/javascript;base64,${Buffer.from(bundle.bundleJs, 'utf8').toString('base64')}`
		evaluated = import(/* @vite-ignore */ url) as Promise<PreviewBundleModule>
		modules.set(bundle, evaluated)
	}
	return evaluated
}

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
 * editor's Event read all report the same state, and a refused plugin is never loaded. A bundle
 * that cannot be evaluated is reported as a bundle failure: the Preview could not load it either.
 */
export function checkPreviewBundleAdapters(bundle: PreviewBundle, workspaceRoot: string): Promise<PreviewAdapterCheck> {
	let check = checks.get(bundle)
	if (!check) {
		check = runCheck(bundle, workspaceRoot)
		checks.set(bundle, check)
	}
	return check
}

async function runCheck(bundle: PreviewBundle, workspaceRoot: string): Promise<PreviewAdapterCheck> {
	const roots = async () => [resolve(workspaceRoot), await realpath(workspaceRoot).catch(() => resolve(workspaceRoot))]
	let reported: unknown
	try {
		reported = (await evaluatePreviewBundle(bundle)).describeAdapterDiagnostics?.()
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		return invalid([{
			code: 'preview.bundle_failed',
			path: '/product-kit',
			message: maskHostPaths(`The Preview bundle could not be evaluated: ${message}`, await roots()),
		}])
	}
	if (!Array.isArray(reported) || !reported.every(isDiagnostic)) {
		return invalid([{ code: 'preview.bundle_failed', path: '/product-kit', message: 'The Preview bundle did not report the checks of its Adapters.' }])
	}
	if (reported.length === 0) return { state: 'valid' }
	const masked = await roots()
	return invalid(reported.map(({ code, path, message }) => ({ code, path, message: maskHostPaths(message, masked) })))
}

function invalid(diagnostics: readonly Diagnostic[]): PreviewAdapterCheck {
	return { state: 'invalid', diagnostics: Object.freeze(diagnostics.map(item => Object.freeze({ ...item }))) }
}

function isDiagnostic(value: unknown): value is Diagnostic {
	return !!value && typeof value === 'object'
		&& typeof (value as Diagnostic).code === 'string'
		&& typeof (value as Diagnostic).path === 'string'
		&& typeof (value as Diagnostic).message === 'string'
}
