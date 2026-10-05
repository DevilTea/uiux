import { chromium, type Browser } from 'playwright'
import packageJson from '../../../package.json' with { type: 'json' }
import { canonicalJsonBytes } from '../../domain/canonical-json'
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

export interface FormalCaptureService {
	capture(command: CaptureFormalEvidenceCommand): Promise<CaptureFormalEvidenceResult>
	listEvidence(viewId?: string): Promise<readonly FormalEvidenceItem[]>
}

export function createFormalCaptureService(
	persistence: FileNativePersistence,
	options?: { serverOrigin?: string },
): FormalCaptureService {
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

		return {
			ok: true,
			registries: {
				locales: localesSet,
				viewports: viewportsRecord,
				themes: themesSet,
				variantsByView,
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
				const browserContext = await browser.newContext({
					viewport: {
						width: context.viewport.width,
						height: context.viewport.height,
					},
					reducedMotion: 'reduce',
				})

				const page = await browserContext.newPage()
				try {
					const url = new URL(`${baseUrl}/preview`)
					url.searchParams.set('viewId', context.viewId)
					url.searchParams.set('locale', context.locale)
					url.searchParams.set('viewportId', context.viewportId)
					url.searchParams.set('viewportWidth', String(context.viewport.width))
					url.searchParams.set('viewportHeight', String(context.viewport.height))
					url.searchParams.set('themeId', context.themeId)
					if (context.variantName) {
						url.searchParams.set('variant', context.variantName)
					}
					url.searchParams.set('harness', 'formal')

					await page.goto(url.href, { waitUntil: 'load', timeout: 15_000 })

					// Inject deterministic capture harness normalization CSS
					await page.addStyleTag({
						content: `
							*, *::before, *::after {
								animation-duration: 0s !important;
								animation-delay: 0s !important;
								transition-duration: 0s !important;
								transition-delay: 0s !important;
								caret-color: transparent !important;
							}
						`,
					})

					// Wait for ready condition
					const statusEl = await page.waitForSelector(
						'[data-preview-status]:not([data-preview-status="loading"])',
						{ timeout: 15_000 },
					)
					const status = await statusEl?.getAttribute('data-preview-status')

					if (status !== 'ready') {
						const isUnavailable = status === 'adapter_unavailable'
						results[index] = {
							context,
							status: 'failed',
							diagnostics: [{
								code: isUnavailable ? 'adapter.materialization_unavailable' : 'preview.runtime_failed',
								path: '/preview',
								message: `Preview runtime status reported '${status}'.`,
							}],
						}
						continue
					}

					// Ensure web fonts are completely ready before capture
					await page.evaluate(() => document.fonts?.ready)

					// Capture deterministic PNG bytes
					const screenshotBytes = await page.screenshot({
						type: 'png',
						fullPage: false,
						animations: 'disabled',
					})

					// Store screenshot in ImmutableArtifactStore
					const { identity: screenshotDigest } = await persistence.artifacts.put(screenshotBytes)

					// Read exact current revisions
					const viewRead = await persistence.views.readInspected(context.viewId)
					const viewRevision = viewRead?.revision ?? 'r_unknown'
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
					await page.close().catch(() => undefined)
					await browserContext.close().catch(() => undefined)
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
		const identities = await persistence.artifacts.listIdentities()
		const items: FormalEvidenceItem[] = []

		for (const identity of identities) {
			const parsed = await persistence.artifacts.readCandidateJson(identity)
			if (!parsed) continue
			const validation = validateFormalEvidenceRecord(parsed)
			if (validation.ok && validation.value.kind === 'formal_capture') {
				if (viewId) {
					const recContext = validation.value.executionContext as Record<string, unknown> | undefined
					if (recContext?.viewId !== viewId) continue
				}
				items.push({
					digest: identity,
					record: validation.value,
				})
			}
		}

		return items.sort((a, b) => a.digest.localeCompare(b.digest))
	}

	return {
		capture,
		listEvidence,
	}
}
