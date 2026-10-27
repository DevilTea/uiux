import { chromium, type Browser } from 'playwright'
import packageJson from '../../../package.json' with { type: 'json' }
import playwrightPackage from 'playwright/package.json' with { type: 'json' }
import { canonicalJsonBytes } from '../../domain/canonical-json'
import { renderInputDigest } from '../../domain/evidence/render-input-digest'
import {
	validateFormalEvidenceRecord,
	type FormalEvidenceRecord,
} from '../../domain/evidence/schema'
import {
	validateRenderContextSelection,
	type RenderContextRegistries,
	type ResolvedRenderContext,
	type ViewportDimensions,
} from '../../domain/render-context/schema'
import type { Diagnostic, JsonObject, JsonValue } from '../../domain/validation'
import type { TranslationEvaluation } from '../../preview/translation-evaluation'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'
import { keptChecksRuns } from '../../persistence/artifact-gc'
import { settledValue } from '../../persistence/file-native'
import type { KitBuildStatus } from '../ports/kit-build'
import { ASSET_LOAD_FAILED_DIAGNOSTIC, ASSET_LOAD_FAILED_STATUS, captureHarnessScreenshot, HARNESS_LAUNCH_ARGS, evaluateHarnessTranslations, openHarnessPreview, type HarnessPreview } from './capture-harness'
import type { InteractionAssertionInput, InteractionStep } from '../../domain/evidence/interaction-replay'
import { replayInteractions, type InteractionReplayOutcome } from './interaction-replay'
import { missingDefaultLocaleError } from './default-locale-gate'
import { createViewAssetBindingCheck, type AssetCatalog } from './asset-bindings'
import { readWorkspaceProductKitProvenance } from './product-kit-provenance'
import { readCurrentAdapterProvenance, type AdapterProvenanceSource } from './adapter-provenance'

export type FormalContextCaptureResult = Readonly<{
	context: ResolvedRenderContext
	status: 'captured' | 'failed'
	evidenceDigest?: string
	screenshotDigest?: string
	evidence?: FormalEvidenceRecord
	diagnostics?: readonly Diagnostic[]
	error?: string
}>

export type CaptureFormalEvidenceCommand = Readonly<{
	contexts: readonly ResolvedRenderContext[]
	baseUrl?: string
}>

export type CaptureFormalEvidenceResult = Readonly<{
	status: 'ok' | 'incomplete' | 'failed'
	results: readonly FormalContextCaptureResult[]
	summary: Readonly<{
		total: number
		captured: number
		failed: number
	}>
	executedAt: string
}>

export type FormalEvidenceItem = Readonly<{
	digest: string
	record: FormalEvidenceRecord
}>

/** Reads the theme support of the current Adapter resolution: the theme IDs it does not support, or `undefined` while the set is invalid. */
export type AdapterThemeSupportSource = () => Promise<Readonly<{ unsupportedThemeIds: readonly string[] }> | undefined>

/** A View's current render-input digest (Clause 01a14e30-2d4a-…) and the revision it was read at. */
export type ViewRenderInput = Readonly<{ key: string; revision: string; renderInputDigest: string }>

/** One recipe replayed in one render context's Preview (see `replay`). */
export type ReplayInteractionsCommand = Readonly<{
	context: ResolvedRenderContext
	steps: readonly InteractionStep[]
	assertions: readonly InteractionAssertionInput[]
	baseUrl?: string
}>

export interface FormalCaptureService {
	capture(command: CaptureFormalEvidenceCommand): Promise<CaptureFormalEvidenceResult>
	/** Replays an interaction recipe in the formal capture harness; the caller captures the context formally itself. */
	replay(command: ReplayInteractionsCommand): Promise<InteractionReplayOutcome>
	/**
	 * The formal captures, or with `kinds` the Evidence records of exactly those kinds (the Submit for
	 * review picker lists `checks_run`, `flow_trace` and `interaction_replay` records this way). Of the
	 * `checks_run` records only the CHECKS_RUN_RETENTION with the newest `ranAt` are listed: older ones are
	 * collectable, and each can hold up to 512 KB of findings.
	 */
	listEvidence(viewId?: string, kinds?: readonly string[]): Promise<readonly FormalEvidenceItem[]>
	/** Every readable View's current render-input digest, against which Evidence freshness is judged. */
	viewRenderInputs(): Promise<readonly ViewRenderInput[]>
}

/** The formal capture record in a parsed artifact, if it is one; used to filter inside the read lock. */
export function formalCaptureRecordOf(value: unknown): FormalEvidenceRecord | undefined {
	return evidenceRecordOfKinds(value, ['formal_capture'])
}

/** The Evidence record in a parsed artifact when it is one of `kinds`. */
function evidenceRecordOfKinds(value: unknown, kinds: readonly string[]): FormalEvidenceRecord | undefined {
	const validation = validateFormalEvidenceRecord(value)
	return validation.ok && kinds.includes(validation.value.kind) ? validation.value : undefined
}

export function createFormalCaptureService(
	persistence: FileNativePersistence,
	options?: {
		serverOrigin?: string
		/** The in-memory `system:capture` credential, sent as a cookie scoped to the internal origin only. */
		captureCookie?: () => Readonly<{ name: string; value: string }> | undefined
		/** The kit build state under `uiux dev`; without it no build runs and capture is not held back. */
		kitBuild?: () => KitBuildStatus
		/**
		 * The theme support of the current Adapter resolution (Rule 01a11add-f46d-7e92-8f5a-9d10dba6473d),
		 * `undefined` while the set is invalid (the Preview then refuses every context itself). Without
		 * it no theme is refused here.
		 */
		themeSupport?: AdapterThemeSupportSource
		/**
		 * Where the recorded Adapter provenance comes from: the server's resolution, the one the Preview
		 * renders with, and the kit build state (Rule 01a167bf-1f93-78b7-9045-6562c20f5a42); without it the
		 * Adapters resolve from disk.
		 */
		adapterProvenance?: AdapterProvenanceSource
	},
): FormalCaptureService {
	// A View whose `$asset` bindings do not resolve is never captured (Rules 01a115cd-c0d2-7427-8a95-927b2b3518c9
	// and 01a167f4-472f-7ae9-8ebb-3075216ad94c): its contexts fail with the binding diagnostics before a browser runs.
	const viewAssetBindings = createViewAssetBindingCheck(persistence, options?.adapterProvenance)

	async function buildRegistries(contexts: readonly ResolvedRenderContext[]): Promise<
		| { ok: true; registries: RenderContextRegistries; workspaceInspection: unknown; workspaceRevision: string }
		| { ok: false; diagnostics: readonly Diagnostic[] }
	> {
		const wsRead = await persistence.workspace.readInspected()
		if (!wsRead.resource || !wsRead.revision) {
			return {
				ok: false,
				diagnostics: [{
					code: 'workspace.manifest_missing',
					path: '/workspace',
					message: 'Selected workspace manifest is missing or unreadable.',
				}],
			}
		}

		const manifest = wsRead.resource
		const defaultLocale = manifest.i18n?.defaultLocale ?? 'en-US'
		const discoveredLocales = await persistence.locales.discover()
		const localesSet = new Set<string>([defaultLocale, ...discoveredLocales])

		const viewportsRecord: Record<string, ViewportDimensions> = {}
		if (manifest.viewports) {
			for (const [id, preset] of Object.entries(manifest.viewports)) {
				if (preset && typeof preset === 'object' && preset.dimensions) {
					viewportsRecord[id] = {
						width: preset.dimensions.width,
						height: preset.dimensions.height,
					}
				}
			}
		}

		const themesSet = new Set<string>(
			manifest.themes ? Object.keys(manifest.themes) : ['light', 'dark'],
		)

		const variantsByView = new Map<string, ReadonlySet<string>>()
		const requestedViewIds = new Set(contexts.map(c => c.viewId))
		const requestedIds = [...requestedViewIds]
		const requestedReads = await persistence.views.readManyInspected(requestedIds)
		for (const [index, vId] of requestedIds.entries()) {
			const viewRead = settledValue(requestedReads[index]!)
			if (viewRead?.resource) {
				const variants = new Set(Object.keys(viewRead.resource.variants ?? {}))
				variantsByView.set(vId, variants)
			}
		}

		// Rule 01a11a5a-566b-70b1-b000-2918519c0d19: a context whose theme the active Adapters do not
		// support is refused (`render_context.incompatible_theme`), never captured with another theme.
		const themeSupport = await options?.themeSupport?.()
		const unsupportedThemes = new Set(themeSupport?.unsupportedThemeIds ?? [])

		return {
			ok: true,
			registries: {
				locales: localesSet,
				viewports: viewportsRecord,
				themes: themesSet,
				variantsByView,
				...(themeSupport ? { themeIsCompatible: (themeId: string) => !unsupportedThemes.has(themeId) } : {}),
			},
			workspaceInspection: wsRead.resource,
			workspaceRevision: wsRead.revision,
		}
	}

	/** The base URL for local preview: the internal server-known origin. */
	function resolveBaseUrl(commandBaseUrl: string | undefined): string {
		const defaultPort = process.env.PORT || process.env.NITRO_PORT || '3000'
		const defaultHost = process.env.HOST || process.env.NITRO_HOST || '127.0.0.1'
		const normalizedHost = (defaultHost === '0.0.0.0' || defaultHost === '::' || defaultHost === '') ? '127.0.0.1' : defaultHost
		return commandBaseUrl
			|| options?.serverOrigin
			|| process.env.UIUX_SERVER_ORIGIN
			|| process.env.UIUX_SERVER_URL
			|| `http://${normalizedHost}:${defaultPort}`
	}

	/**
	 * Rules 01a11544-66d9-… and 01a115cd-c507-…: opens `context` in the formal capture harness and replays
	 * the recipe against its Preview (the shared replay engine), in a fresh browser that is closed again.
	 * It stores nothing; the caller has formally captured the same context.
	 */
	async function replay(command: ReplayInteractionsCommand): Promise<InteractionReplayOutcome> {
		const failure = (code: string, path: string, message: string): InteractionReplayOutcome => ({ status: 'failed', diagnostics: [{ code, path, message }] })
		let browser: Browser
		try {
			browser = await chromium.launch({ headless: true, args: [...HARNESS_LAUNCH_ARGS] })
		}
		catch (cause) {
			return failure('capture.browser_launch_failed', '/capture', `Playwright browser could not be launched: ${cause instanceof Error ? cause.message : String(cause)}`)
		}
		let preview: HarnessPreview | undefined
		try {
			preview = await openHarnessPreview(browser, { baseUrl: resolveBaseUrl(command.baseUrl), context: command.context, cookie: options?.captureCookie?.() })
			if (preview.status !== 'ready')
				return failure(preview.previewStatus === 'adapter_unavailable' ? 'adapter.materialization_unavailable' : 'preview.runtime_failed', '/preview', `Preview runtime status reported '${preview.previewStatus}'.`)
			return await replayInteractions(preview.page, command)
		}
		catch (cause) {
			return failure('capture.execution_failed', '/capture', cause instanceof Error ? cause.message : 'Execution failed during the interaction replay')
		}
		finally {
			await preview?.close()
			await browser.close().catch(() => undefined)
		}
	}

	async function capture(command: CaptureFormalEvidenceCommand): Promise<CaptureFormalEvidenceResult> {
		const contexts = command.contexts
		if (!Array.isArray(contexts) || contexts.length === 0) {
			return {
				status: 'failed',
				results: [],
				summary: { total: 0, captured: 0, failed: 0 },
				executedAt: new Date().toISOString(),
			}
		}

		// Capture stores artifacts, so it is refused before launching a browser unless the Workspace
		// is at the current schema (`workspace.schema_unsupported` otherwise).
		const { inspection } = await persistence.inspectWorkspace()
		if (inspection.state === 'unsupported') {
			const diagnostics: readonly Diagnostic[] = inspection.diagnostics
			return {
				status: 'failed',
				results: contexts.map(context => ({ context, status: 'failed', diagnostics })),
				summary: { total: contexts.length, captured: 0, failed: contexts.length },
				executedAt: new Date().toISOString(),
			}
		}

		// Rule 01a11bb1-9f2f-7559-b2ae-d61320f46627: formal capture is refused while a kit build is
		// running or after its last run failed, before a browser is launched or anything is stored.
		const build = options?.kitBuild?.()
		if (build && (build.state === 'building' || build.state === 'failed')) {
			const message = build.state === 'building'
				? 'Formal capture waits for the kit build: a build is running. Capture again once the build state is ready (uiux://product-kit).'
				: 'Formal capture is refused while the last kit build has failed. Fix the kit project, then restart the build (restart_kit_build).'
			const diagnostics: readonly Diagnostic[] = [{ code: 'capture.kit_build_not_ready', path: '/product-kit/build', message }]
			return {
				status: 'failed',
				results: contexts.map(context => ({ context, status: 'failed', diagnostics })),
				summary: { total: contexts.length, captured: 0, failed: contexts.length },
				executedAt: new Date().toISOString(),
			}
		}

		// Rule 01a115cd-b30b-706e-b8a2-46e62259156e: while the default Locale has no Locale file, every
		// context is refused (no Locale stands in for the default), so no formal Evidence is produced.
		const localeError = await missingDefaultLocaleError(persistence)
		if (localeError) {
			const diagnostics: readonly Diagnostic[] = [localeError]
			return {
				status: 'failed',
				results: contexts.map(context => ({ context, status: 'failed', diagnostics })),
				summary: { total: contexts.length, captured: 0, failed: contexts.length },
				executedAt: new Date().toISOString(),
			}
		}

		const registriesResult = await buildRegistries(contexts)
		if (!registriesResult.ok) {
			const failedResults: FormalContextCaptureResult[] = contexts.map(context => ({
				context,
				status: 'failed',
				diagnostics: registriesResult.diagnostics,
			}))
			return {
				status: 'failed',
				results: failedResults,
				summary: { total: contexts.length, captured: 0, failed: contexts.length },
				executedAt: new Date().toISOString(),
			}
		}

		const { registries, workspaceInspection, workspaceRevision } = registriesResult
		const wsSchemaVersion = (workspaceInspection as { schemaVersion?: number }).schemaVersion ?? 1

		const results: FormalContextCaptureResult[] = new Array(contexts.length)
		const validContexts: Array<{ context: ResolvedRenderContext; index: number }> = []
		const bindingDiagnosticsByView = new Map<string, readonly Diagnostic[]>()
		let bindingCatalog: Promise<AssetCatalog> | undefined
		const sharedBindingCatalog = () => bindingCatalog ??= viewAssetBindings.catalog()

		// 1. Strict validation per context against Workspace registries
		for (let i = 0; i < contexts.length; i++) {
			const context = contexts[i]!
			const selectionValidation = validateRenderContextSelection([context], registries)
			if (!selectionValidation.ok) {
				results[i] = {
					context,
					status: 'failed',
					diagnostics: selectionValidation.diagnostics,
				}
				continue
			}

			// Check View existence
			const viewRead = await persistence.views.readInspected(context.viewId)
			if (!viewRead?.resource || !viewRead.revision) {
				results[i] = {
					context,
					status: 'failed',
					diagnostics: [{
						code: 'view.not_found',
						path: `/viewId`,
						message: `View ${context.viewId} was not found in the selected Workspace.`,
					}],
				}
				continue
			}

			let bindingDiagnostics = bindingDiagnosticsByView.get(context.viewId)
			if (!bindingDiagnostics) {
				bindingDiagnostics = await viewAssetBindings.check(viewRead.resource.ir, sharedBindingCatalog)
				bindingDiagnosticsByView.set(context.viewId, bindingDiagnostics)
			}
			if (bindingDiagnostics.length > 0) {
				results[i] = { context, status: 'failed', diagnostics: bindingDiagnostics }
				continue
			}

			validContexts.push({ context, index: i })
		}

		if (validContexts.length === 0) {
			const failedCount = results.filter(r => r && r.status === 'failed').length
			return {
				status: 'failed',
				results,
				summary: { total: contexts.length, captured: 0, failed: failedCount },
				executedAt: new Date().toISOString(),
			}
		}

		const baseUrl = resolveBaseUrl(command.baseUrl)

		// Clause 01a11bb1-8fc4-7b7d-87da-d3fc5d457d98: each record carries the Product Kit provenance
		// of the Workspace at capture time, taken once for the run.
		const productKit = await readWorkspaceProductKitProvenance(persistence)
		// Clause 01a1161c-008a-746d-8d53-a8301b23588f: and the provenance of every Adapter of the active
		// set, in Adapter-list order, also taken once. A capture taken while it cannot be computed records
		// none, so its freshness is unknown (Rule 01a1161b-ff68-…).
		const adapters = await readCurrentAdapterProvenance(persistence, options?.adapterProvenance ?? (options?.kitBuild ? { kitBuild: options.kitBuild } : undefined))

		let browser: Browser | undefined
		try {
			browser = await chromium.launch({ headless: true, args: [...HARNESS_LAUNCH_ARGS] })
		}
		catch (cause) {
			const launchError = cause instanceof Error ? cause.message : String(cause)
			for (const { context, index } of validContexts) {
				results[index] = {
					context,
					status: 'failed',
					error: launchError,
					diagnostics: [{
						code: 'capture.browser_launch_failed',
						path: '/capture',
						message: `Playwright browser could not be launched: ${launchError}`,
					}],
				}
			}
			return {
				status: 'failed',
				results,
				summary: { total: contexts.length, captured: 0, failed: contexts.length },
				executedAt: new Date().toISOString(),
			}
		}

		try {
			// 2. Execute each valid context in a fresh isolated browser context & page
			for (const { context, index } of validContexts) {
				let preview: HarnessPreview | undefined
				try {
					preview = await openHarnessPreview(browser, { baseUrl, context, cookie: options?.captureCookie?.() })

					if (preview.status !== 'ready') {
						const status = preview.previewStatus
						const isUnavailable = status === 'adapter_unavailable'
						results[index] = {
							context,
							status: 'failed',
							diagnostics: [status === ASSET_LOAD_FAILED_STATUS
								// A bound Asset image did not decode (its content changed since it was resolved, or its bytes
								// are not an image); nothing is captured in its place (Rule 01a115cd-c106-71d6-b1f8-4d59cab22ad2).
								? ASSET_LOAD_FAILED_DIAGNOSTIC
								: {
										code: isUnavailable ? 'adapter.materialization_unavailable' : 'preview.runtime_failed',
										path: '/preview',
										message: `Preview runtime status reported '${status}'.`,
									}],
						}
						continue
					}

					// Capture deterministic PNG bytes
					const screenshotBytes = await captureHarnessScreenshot(preview.page)
					// A bound Asset request that failed up to the screenshot (of any element or style) fails the context.
					if (preview.assetLoadFailures() > 0) {
						results[index] = { context, status: 'failed', diagnostics: [ASSET_LOAD_FAILED_DIAGNOSTIC] }
						continue
					}

					// Rule 01a115cd-ba68-7c73-a157-08ef34be1e54: every Catalog-declared translation-result Property of
					// this View and Variant is evaluated, hidden Widgets included. A context whose evaluation cannot
					// run at all is not captured: a record never claims coverage without it (Rule 01a115cd-ba9b-…).
					let translations: TranslationEvaluation
					try {
						translations = await evaluateHarnessTranslations(preview.page)
					}
					catch (cause) {
						const reason = cause instanceof Error ? cause.message : String(cause)
						results[index] = {
							context,
							status: 'failed',
							error: reason,
							diagnostics: [{ code: 'capture.translation_evaluation_failed', path: '/preview', message: `The translation Properties could not be evaluated: ${reason}` }],
						}
						continue
					}

					// Store screenshot in ImmutableArtifactStore
					const { identity: screenshotDigest } = await persistence.artifacts.put(screenshotBytes)

					// Read exact current revisions
					const viewRead = await persistence.views.readInspected(context.viewId)
					const viewRevision = viewRead?.revision ?? 'r_unknown'
					// Clause 01a14e30-2d4a-…: the render-input digest of the same read as the View revision.
					const viewRenderInputDigest = viewRead?.resource ? renderInputDigest(viewRead.resource) : undefined
					const localeRevision = await persistence.locales.readRevision(context.locale)

					const provenanceResources: Array<{ identity: JsonObject; revision: string }> = [
						{ identity: { type: 'view', id: context.viewId }, revision: viewRevision },
						{ identity: { type: 'workspace', id: 'workspace' }, revision: workspaceRevision },
					]
					if (localeRevision) {
						provenanceResources.push({ identity: { type: 'locale', id: context.locale }, revision: localeRevision })
					}
					provenanceResources.sort((a, b) => {
						const typeCmp = String(a.identity.type).localeCompare(String(b.identity.type))
						return typeCmp !== 0 ? typeCmp : String(a.identity.id).localeCompare(String(b.identity.id))
					})

					const formalRecord: FormalEvidenceRecord = {
						schemaVersion: 1,
						kind: 'formal_capture',
						executionContext: {
							locale: context.locale,
							themeId: context.themeId,
							viewId: context.viewId,
							viewport: {
								height: context.viewport.height,
								width: context.viewport.width,
							},
							viewportId: context.viewportId,
							...(context.variantName ? { variantName: context.variantName } : {}),
						},
						// Clauses 01a17245-05a6-… and 01a17245-062a-…: complete only when every declared translation-result
						// Property was evaluated; warnings are data and never a gap (Rule 01a17245-0819-…).
						coverage: translations.missing.length === 0
							? { complete: true, translations: { complete: true, evaluated: translations.entries.length } }
							: { complete: false, translations: { complete: false, missing: translations.missing as unknown as JsonValue[] } },
						provenance: {
							workspaceSchemaVersion: wsSchemaVersion,
							resources: provenanceResources,
							versions: {
								uiux: packageJson.version,
								// Clause 01a115cd-cecb-747b-b28d-aa083893bff2: the engine that produced this capture.
								playwright: playwrightPackage.version,
								chromium: browser.version(),
							},
							...(productKit ? { productKit } : {}),
							...(adapters.state === 'available' ? { adapters: adapters.adapters } : {}),
							...(viewRenderInputDigest ? { renderInputDigest: viewRenderInputDigest } : {}),
						},
						artifactRefs: [screenshotDigest],
						data: {
							format: 'png',
							width: context.viewport.width,
							height: context.viewport.height,
							translations: translations.entries as unknown as JsonValue[],
						},
					}

					const recordValidation = validateFormalEvidenceRecord(formalRecord)
					if (!recordValidation.ok) {
						results[index] = {
							context,
							status: 'failed',
							diagnostics: recordValidation.diagnostics,
						}
						continue
					}

					// Serialize deterministically and store serialized record in artifact store
					const serializedRecordBytes = canonicalJsonBytes(formalRecord)
					const { identity: evidenceDigest } = await persistence.artifacts.put(serializedRecordBytes)

					results[index] = {
						context,
						status: 'captured',
						evidenceDigest,
						screenshotDigest,
						evidence: formalRecord,
					}
				}
				catch (cause) {
					results[index] = {
						context,
						status: 'failed',
						error: cause instanceof Error ? cause.message : String(cause),
						diagnostics: [{
							code: 'capture.execution_failed',
							path: '/capture',
							message: cause instanceof Error ? cause.message : 'Execution failed during capture',
						}],
					}
				}
				finally {
					await preview?.close()
				}
			}
		}
		finally {
			if (browser) {
				await browser.close().catch(() => undefined)
			}
		}

		const captured = results.filter(r => r.status === 'captured').length
		const failed = results.filter(r => r.status === 'failed').length
		const overallStatus = failed === 0 ? 'ok' : captured === 0 ? 'failed' : 'incomplete'

		return {
			status: overallStatus,
			results,
			summary: {
				total: contexts.length,
				captured,
				failed,
			},
			executedAt: new Date().toISOString(),
		}
	}

	async function listEvidence(viewId?: string, kinds: readonly string[] = ['formal_capture']): Promise<readonly FormalEvidenceItem[]> {
		// One snapshot under one shared lock, not one lock acquisition per artifact (issue #318).
		const candidates = await persistence.artifacts.readAllCandidateJson<unknown, FormalEvidenceRecord>({ select: value => evidenceRecordOfKinds(value, kinds) })
		const items: FormalEvidenceItem[] = []

		for (const { identity, value: record } of candidates) {
			if (viewId) {
				const recContext = record.executionContext as Record<string, unknown> | undefined
				if (recContext?.viewId !== viewId) continue
			}
			items.push({ digest: identity, record })
		}

		const newestRuns = new Set(keptChecksRuns(items.filter(item => item.record.kind === 'checks_run').map(item => ({ identity: item.digest, ranAt: (item.record.executionContext as Record<string, unknown>).ranAt }))))
		return items.filter(item => item.record.kind !== 'checks_run' || newestRuns.has(item.digest)).sort((a, b) => a.digest.localeCompare(b.digest))
	}

	async function viewRenderInputs(): Promise<readonly ViewRenderInput[]> {
		const inputs: ViewRenderInput[] = []
		// Every View is read under ONE shared lock (issue #322), not one lock per View.
		for (const { key, read: settled } of await persistence.views.readAllInspected()) {
			// A View file that is not valid JSON has no render input: skip it (as View discovery does) so
			// the other Views and the Evidence list still load; its Evidence then reads as stale (View missing).
			let read: Awaited<ReturnType<typeof persistence.views.readInspected>>
			try { read = settledValue(settled) }
			catch (error: unknown) {
				if (error instanceof PersistenceError && error.code === 'persistence.invalid_json') continue
				throw error
			}
			if (!read?.resource || !read.revision) continue
			inputs.push({ key, revision: read.revision, renderInputDigest: renderInputDigest(read.resource) })
		}
		return inputs.sort((a, b) => a.key.localeCompare(b.key))
	}

	return {
		capture,
		replay,
		listEvidence,
		viewRenderInputs,
	}
}
