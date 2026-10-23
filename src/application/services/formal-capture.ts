import { chromium, type Browser } from 'playwright'
import packageJson from '../../../package.json' with { type: 'json' }
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
import type { Diagnostic, JsonObject } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'
import type { KitBuildStatus } from '../ports/kit-build'
import { ASSET_LOAD_FAILED_STATUS, captureHarnessScreenshot, openHarnessPreview, type HarnessPreview } from './capture-harness'
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

export interface FormalCaptureService {
	capture(command: CaptureFormalEvidenceCommand): Promise<CaptureFormalEvidenceResult>
	listEvidence(viewId?: string): Promise<readonly FormalEvidenceItem[]>
	/** Every readable View's current render-input digest, against which Evidence freshness is judged. */
	viewRenderInputs(): Promise<readonly ViewRenderInput[]>
}

/** The formal capture record in a parsed artifact, if it is one; used to filter inside the read lock. */
export function formalCaptureRecordOf(value: unknown): FormalEvidenceRecord | undefined {
	const validation = validateFormalEvidenceRecord(value)
	return validation.ok && validation.value.kind === 'formal_capture' ? validation.value : undefined
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
		for (const vId of requestedViewIds) {
			const viewRead = await persistence.views.readInspected(vId)
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

		// Resolve base URL for local preview: internal server-known origin
		const defaultPort = process.env.PORT || process.env.NITRO_PORT || '3000'
		const defaultHost = process.env.HOST || process.env.NITRO_HOST || '127.0.0.1'
		const normalizedHost = (defaultHost === '0.0.0.0' || defaultHost === '::' || defaultHost === '') ? '127.0.0.1' : defaultHost
		const baseUrl = command.baseUrl
			|| options?.serverOrigin
			|| process.env.UIUX_SERVER_ORIGIN
			|| process.env.UIUX_SERVER_URL
			|| `http://${normalizedHost}:${defaultPort}`

		// Clause 01a11bb1-8fc4-7b7d-87da-d3fc5d457d98: each record carries the Product Kit provenance
		// of the Workspace at capture time, taken once for the run.
		const productKit = await readWorkspaceProductKitProvenance(persistence)
		// Clause 01a1161c-008a-746d-8d53-a8301b23588f: and the provenance of every Adapter of the active
		// set, in Adapter-list order, also taken once. A capture taken while it cannot be computed records
		// none, so its freshness is unknown (Rule 01a1161b-ff68-…).
		const adapters = await readCurrentAdapterProvenance(persistence, options?.adapterProvenance ?? (options?.kitBuild ? { kitBuild: options.kitBuild } : undefined))

		let browser: Browser | undefined
		try {
			browser = await chromium.launch({ headless: true })
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
								? { code: 'capture.asset_load_failed', path: '/preview', message: 'An image of a bound Asset did not load or decode in the Preview, so the context was not captured.' }
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
						coverage: {
							complete: true,
						},
						provenance: {
							workspaceSchemaVersion: wsSchemaVersion,
							resources: provenanceResources,
							versions: {
								uiux: packageJson.version,
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

	async function listEvidence(viewId?: string): Promise<readonly FormalEvidenceItem[]> {
		// One snapshot under one shared lock, not one lock acquisition per artifact (issue #318).
		const candidates = await persistence.artifacts.readAllCandidateJson<unknown, FormalEvidenceRecord>({ select: formalCaptureRecordOf })
		const items: FormalEvidenceItem[] = []

		for (const { identity, value: record } of candidates) {
			if (viewId) {
				const recContext = record.executionContext as Record<string, unknown> | undefined
				if (recContext?.viewId !== viewId) continue
			}
			items.push({ digest: identity, record })
		}

		return items.sort((a, b) => a.digest.localeCompare(b.digest))
	}

	async function viewRenderInputs(): Promise<readonly ViewRenderInput[]> {
		const inputs: ViewRenderInput[] = []
		for (const key of await persistence.views.discoverKeys()) {
			// A View file that is not valid JSON has no render input: skip it (as View discovery does) so
			// the other Views and the Evidence list still load; its Evidence then reads as stale (View missing).
			const read = await persistence.views.readInspected(key).catch((error: unknown) => {
				if (error instanceof PersistenceError && error.code === 'persistence.invalid_json') return undefined
				throw error
			})
			if (!read?.resource || !read.revision) continue
			inputs.push({ key, revision: read.revision, renderInputDigest: renderInputDigest(read.resource) })
		}
		return inputs.sort((a, b) => a.key.localeCompare(b.key))
	}

	return {
		capture,
		listEvidence,
		viewRenderInputs,
	}
}
