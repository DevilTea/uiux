import packageJson from '../../../package.json' with { type: 'json' }
import { canonicalJsonBytes } from '../../domain/canonical-json'
import { FLOW_TRACE_KIND, validateFormalEvidenceRecord, type FormalEvidenceRecord } from '../../domain/evidence/schema'
import { deriveFlowRecipe, flowRecipeEntries, validateFlowRecipe, type FlowRecipe, type FlowRecipeEntry } from '../../domain/flows/recipe'
import type { FlowResource } from '../../domain/flows/schema'
import type { ResolvedRenderContext } from '../../domain/render-context/schema'
import { isFullUuid, isRecord, type Diagnostic, type JsonObject, type JsonValue } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'
import type { CaptureFormalEvidenceCommand, CaptureFormalEvidenceResult, ReplayInteractionsCommand } from './formal-capture'
import type { InteractionReplayOutcome } from './interaction-replay'

/** The render context a Flow trace is captured in: every step's View and Variant is captured in it. */
export type FlowRenderContext = Readonly<{ locale: string; viewportId: string; themeId: string }>

export type CaptureFlowEvidenceCommand = Readonly<{
	flowId: string
	renderContext: FlowRenderContext
	/** The replay recipe; the server derives one from the Flow when it is omitted. */
	recipe?: unknown
	baseUrl?: string
}>

/** One formal capture a trace references. */
export type FlowCaptureSummary = Readonly<{ viewId: string; variantName?: string; evidenceDigest: string; screenshotDigest: string }>

export type CaptureFlowEvidenceResult =
	| Readonly<{ status: 'captured'; flowId: string; evidenceDigest: string; evidence: FormalEvidenceRecord; captures: readonly FlowCaptureSummary[] }>
	| Readonly<{ status: 'not_found'; flowId: string }>
	| Readonly<{ status: 'invalid'; flowId: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'failed'; flowId: string; diagnostics: readonly Diagnostic[] }>

/** A Flow as the server reports it: its resource and revision, with every diagnostic (structural and reference). */
export type FlowDiagnosticRead = Readonly<{ resource: FlowResource; revision: string; diagnostics: readonly Diagnostic[] }>

export interface FlowEvidenceService {
	capture(command: CaptureFlowEvidenceCommand): Promise<CaptureFlowEvidenceResult>
}

const invalid = (flowId: string, diagnostics: readonly Diagnostic[]): CaptureFlowEvidenceResult => ({ status: 'invalid', flowId, diagnostics })

/**
 * Formal UX Flow Evidence (Rules 01a11544-6628-73b9-b10a-9643d264bea1 and 01a11544-62c8-7d37-933b-b991fed72e30,
 * Clauses 01a172cc-e195-711b-bfa9-5de6c1c8ff87 and 01a172cc-d382-7cd3-b140-6320d2065edc): a Flow with any
 * diagnostic is refused; otherwise every View and Variant the recipe enters is formally captured by the
 * formal capture harness in the render context, each trigger is replayed as its `perform` browser action on
 * the entered View's Preview (Rule 01a11544-66d9-7fcd-8400-93516ddf2857, through the shared interaction
 * replay engine) asserting the Widget Event exactly once, and the trace that references those captures is
 * stored. A trigger whose Event does not occur exactly once is recorded as `valid: false`; a replay that
 * cannot run fails the run.
 */
export function createFlowEvidenceService(
	persistence: FileNativePersistence,
	input: Readonly<{
		readFlow(flowId: string): Promise<FlowDiagnosticRead | undefined>
		captureFormal(command: CaptureFormalEvidenceCommand): Promise<CaptureFormalEvidenceResult>
		replay(command: ReplayInteractionsCommand): Promise<InteractionReplayOutcome>
	}>,
): FlowEvidenceService {
	async function capture(command: CaptureFlowEvidenceCommand): Promise<CaptureFlowEvidenceResult> {
		const flowId = command.flowId
		if (!isFullUuid(flowId)) return { status: 'not_found', flowId }
		let flowRead: FlowDiagnosticRead | undefined
		try { flowRead = await input.readFlow(flowId) }
		catch (error) {
			if (error instanceof PersistenceError && error.code === 'persistence.invalid_json') return invalid(flowId, error.diagnostics)
			throw error
		}
		if (!flowRead) return { status: 'not_found', flowId }
		// Rule 01a11544-62c8-7d37-933b-b991fed72e30: a remaining Flow validation error blocks formal Flow Evidence.
		if (flowRead.diagnostics.length > 0) return invalid(flowId, flowRead.diagnostics)
		const flow = flowRead.resource

		const rawContext: unknown = command.renderContext
		if (!isRecord(rawContext) || ['locale', 'viewportId', 'themeId'].some(key => typeof rawContext[key] !== 'string' || rawContext[key] === ''))
			return invalid(flowId, [{ code: 'flow.invalid_render_context', path: '/renderContext', message: 'renderContext is { locale, viewportId, themeId }, each a non-empty string.' }])
		const context = rawContext as FlowRenderContext
		const workspace = await persistence.workspace.readInspected()
		if (!workspace.resource || !workspace.revision)
			return { status: 'failed', flowId, diagnostics: [{ code: 'workspace.manifest_missing', path: '/workspace', message: 'Selected workspace manifest is missing or unreadable.' }] }
		const preset = workspace.resource.viewports?.[context.viewportId]
		if (!preset?.dimensions)
			return invalid(flowId, [{ code: 'render_context.unknown_viewport', path: '/renderContext/viewportId', message: `Viewport ${context.viewportId} does not exist in the Workspace.` }])

		let recipe: FlowRecipe
		// A derived recipe is checked like a given one: a trigger whose Event is not `press` has no default `perform`.
		if (command.recipe === undefined) recipe = deriveFlowRecipe(flow)
		else recipe = command.recipe as FlowRecipe
		const recipeDiagnostics = validateFlowRecipe(recipe, flow)
		if (recipeDiagnostics.length > 0) return invalid(flowId, recipeDiagnostics)
		const entries = flowRecipeEntries(recipe)

		const contexts: ResolvedRenderContext[] = []
		const contextOf = new Map<string, number>()
		const keyOf = (entry: FlowRecipeEntry) => JSON.stringify([entry.viewId, entry.variantName ?? null])
		for (const entry of entries) {
			if (contextOf.has(keyOf(entry))) continue
			contextOf.set(keyOf(entry), contexts.length)
			contexts.push({
				viewId: entry.viewId,
				...(entry.variantName !== undefined ? { variantName: entry.variantName } : {}),
				locale: context.locale,
				viewportId: context.viewportId,
				viewport: { width: preset.dimensions.width, height: preset.dimensions.height },
				themeId: context.themeId,
			})
		}
		const captured = await input.captureFormal({ contexts, ...(command.baseUrl ? { baseUrl: command.baseUrl } : {}) })
		const failures = captured.results.filter(result => result.status !== 'captured' || !result.evidenceDigest || !result.evidence || !result.screenshotDigest)
		if (failures.length > 0 || captured.results.length !== contexts.length) {
			const diagnostics = failures.flatMap(result => result.diagnostics ?? [{ code: 'capture.execution_failed', path: '/capture', message: result.error ?? 'The capture failed.' }])
			// A render context key the Workspace does not have is the caller's input, not a failed capture.
			return diagnostics.length > 0 && diagnostics.every(item => item.code.startsWith('render_context.'))
				? invalid(flowId, diagnostics)
				: { status: 'failed', flowId, diagnostics }
		}

		// Every trigger is performed in a fresh Preview of its step's View and Variant, and held only when its Event occurred exactly once.
		// The step it leads to (`resultStepId`) was matched against the canonical Flow when the recipe was validated.
		const held: boolean[] = []
		for (const entry of entries) {
			if (!entry.trigger) { held.push(true); continue }
			const perform = entry.perform!
			const replayed = await input.replay({
				context: contexts[contextOf.get(keyOf(entry))!]!,
				steps: [{
					action: perform.action,
					target: { viewId: entry.viewId, ...(entry.variantName !== undefined ? { variant: entry.variantName } : {}), widgetId: entry.trigger.widgetId },
					...(perform.text !== undefined ? { text: perform.text } : {}),
					...(perform.key !== undefined ? { key: perform.key } : {}),
				}],
				assertions: [{ expect: { widgetEvent: { widgetId: entry.trigger.widgetId, name: entry.trigger.event, count: 1 } } }],
				...(command.baseUrl ? { baseUrl: command.baseUrl } : {}),
			})
			if (replayed.status !== 'replayed') return { status: 'failed', flowId, diagnostics: replayed.diagnostics }
			held.push(replayed.results[0] === 'pass')
		}

		const captureDigests = captured.results.map(result => result.evidenceDigest!)
		const steps = entries.map((entry, index) => ({
			stepId: entry.stepId,
			viewId: entry.viewId,
			...(entry.variantName !== undefined ? { variantName: entry.variantName } : {}),
			...(entry.trigger ? { trigger: { widgetId: entry.trigger.widgetId, event: entry.trigger.event }, resultStepId: entry.resultStepId! } : {}),
			valid: held[index]!,
			captureRef: captureDigests[contextOf.get(keyOf(entry))!]!,
		}))

		const resources = new Map<string, { identity: JsonObject; revision: string }>()
		const addResource = (identity: JsonObject, revision: string) => {
			const key = JSON.stringify([identity.type, identity.id])
			if (!resources.has(key)) resources.set(key, { identity, revision })
		}
		addResource({ type: 'flow', id: flowId }, flowRead.revision)
		for (const result of captured.results)
			for (const resource of result.evidence!.provenance.resources) addResource(resource.identity, resource.revision)
		const evidenceRefs = [...new Set(captureDigests)].sort().map(evidence => ({ kind: 'formal_capture', evidence }))

		const record: FormalEvidenceRecord = {
			schemaVersion: 1,
			kind: FLOW_TRACE_KIND,
			executionContext: { flowId, locale: context.locale, viewportId: context.viewportId, themeId: context.themeId },
			coverage: { complete: captured.results.every(result => result.evidence!.coverage.complete) },
			provenance: {
				workspaceSchemaVersion: captured.results[0]!.evidence!.provenance.workspaceSchemaVersion,
				resources: [...resources.values()].sort((a, b) => String(a.identity.type).localeCompare(String(b.identity.type)) || String(a.identity.id).localeCompare(String(b.identity.id))),
				versions: { uiux: packageJson.version },
			},
			artifactRefs: [],
			evidenceRefs,
			data: { recipe: recipe as unknown as JsonValue, steps: steps as unknown as JsonValue[] } as JsonObject,
		}
		const validation = validateFormalEvidenceRecord(record)
		if (!validation.ok) return { status: 'failed', flowId, diagnostics: validation.diagnostics }
		const { identity: evidenceDigest } = await persistence.artifacts.put(canonicalJsonBytes(record))
		return {
			status: 'captured',
			flowId,
			evidenceDigest,
			evidence: record,
			captures: contexts.map((ctx, index) => ({
				viewId: ctx.viewId,
				...(ctx.variantName !== undefined ? { variantName: ctx.variantName } : {}),
				evidenceDigest: captured.results[index]!.evidenceDigest!,
				screenshotDigest: captured.results[index]!.screenshotDigest!,
			})),
		}
	}
	return { capture }
}
