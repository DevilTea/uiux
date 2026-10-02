import type { WidgetSystemRuntime, WidgetSystemRuntimeDiagnostic } from '@deviltea/widget-core'
import { inspectBlueprint } from '@deviltea/widget-core/inspection'

import type { Diagnostic } from '../domain/validation'
import { validateResolvedRenderContext, type ResolvedRenderContext } from '../domain/render-context/schema'
import type { VariantEntry, ViewResource } from '../domain/views/schema'
import { validateViewResource } from '../domain/views/schema'
import type { RuntimeAdapterBundle } from './adapter-runtime'
import { buildEffectiveViewSource } from './effective-view-source'
import type { RootShellViewport } from './root-shell'

export type ViewRuntimeBuildResult =
	| Readonly<{ state: 'ready'; runtime: WidgetSystemRuntime; context: ResolvedRenderContext }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>

export class LiveViewRuntimeController {
	private currentRuntime: WidgetSystemRuntime
	private currentContext: ResolvedRenderContext
	private disposed = false

	private constructor(
		private readonly view: ViewResource,
		private readonly adapters: RuntimeAdapterBundle,
		initial: Readonly<{ runtime: WidgetSystemRuntime; context: ResolvedRenderContext }>,
	) {
		this.currentRuntime = initial.runtime
		this.currentContext = initial.context
	}

	static create(input: Readonly<{
		view: ViewResource
		adapters: RuntimeAdapterBundle
		context: ResolvedRenderContext
	}>): ViewRuntimeBuildResult | LiveViewRuntimeController {
		const initial = buildViewRuntime(input)
		if (initial.state === 'invalid') return initial
		return new LiveViewRuntimeController(input.view, input.adapters, initial)
	}

	get runtime(): WidgetSystemRuntime { this.assertActive(); return this.currentRuntime }
	get context(): ResolvedRenderContext { this.assertActive(); return this.currentContext }

	updateLocale(locale: string): readonly Diagnostic[] {
		this.assertActive()
		const nextContext = { ...this.currentContext, locale }
		const validation = validateResolvedRenderContext(nextContext)
		if (!validation.ok) return validation.diagnostics
		const result = this.rootState('locale').set(locale)
		if (!result.ok) return coreDiagnostics(result.failure.diagnostics, '/runtime/root/locale')
		this.currentContext = { ...this.currentContext, locale }
		return []
	}

	updateViewport(viewportId: string, viewport: Readonly<{ width: number; height: number }>): readonly Diagnostic[] {
		this.assertActive()
		const nextContext = { ...this.currentContext, viewportId, viewport: { ...viewport } }
		const validation = validateResolvedRenderContext(nextContext)
		if (!validation.ok) return validation.diagnostics
		const value: RootShellViewport = { id: viewportId, ...viewport }
		const result = this.rootState('viewport').set(value)
		if (!result.ok) return coreDiagnostics(result.failure.diagnostics, '/runtime/root/viewport')
		this.currentContext = { ...this.currentContext, viewportId, viewport: { ...viewport } }
		return []
	}

	updateTheme(themeId: string): readonly Diagnostic[] {
		this.assertActive()
		const nextContext = { ...this.currentContext, themeId }
		const validation = validateResolvedRenderContext(nextContext)
		if (!validation.ok) return validation.diagnostics
		const result = this.rootState('themeId').set(themeId)
		if (!result.ok) return coreDiagnostics(result.failure.diagnostics, '/runtime/root/themeId')
		this.currentContext = { ...this.currentContext, themeId }
		return []
	}

	switchVariant(variantName?: string): ViewRuntimeBuildResult {
		this.assertActive()
		const nextContext: ResolvedRenderContext = variantName === undefined
			? withoutVariant(this.currentContext)
			: { ...this.currentContext, variantName }
		const next = buildViewRuntime({ view: this.view, adapters: this.adapters, context: nextContext })
		if (next.state === 'invalid') return next
		const previous = this.currentRuntime
		this.currentRuntime = next.runtime
		this.currentContext = next.context
		previous.dispose()
		return next
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.currentRuntime.dispose()
	}

	private rootState(key: 'locale' | 'viewport' | 'themeId') {
		const root = this.currentRuntime.getWidget('root') as unknown as { state?: Record<string, { set(value: unknown): { ok: true; value: unknown } | { ok: false; failure: { diagnostics: readonly WidgetSystemRuntimeDiagnostic[] } } }> } | null
		const state = root?.state?.[key]
		if (!state) throw new Error(`UIUX RootShell runtime is missing State member ${key}.`)
		return state
	}

	private assertActive(): void {
		if (this.disposed) throw new Error('LiveViewRuntimeController is disposed.')
	}
}

export function buildViewRuntime(input: Readonly<{
	view: ViewResource
	adapters: RuntimeAdapterBundle
	context: ResolvedRenderContext
}>): ViewRuntimeBuildResult {
	const viewValidation = validateViewResource(input.view)
	if (!viewValidation.ok) return { state: 'invalid', diagnostics: viewValidation.diagnostics }
	const contextValidation = validateResolvedRenderContext(input.context)
	if (!contextValidation.ok) return { state: 'invalid', diagnostics: contextValidation.diagnostics }
	if (input.context.viewId !== input.view.id)
		return { state: 'invalid', diagnostics: [{ code: 'render_context.view_mismatch', path: '/viewId', message: 'Render context viewId must match the View being executed.' }] }

	const effectiveSource = buildEffectiveViewSource(input.view.ir, input.adapters.catalogByType)
	if (effectiveSource.state === 'invalid') return effectiveSource
	const blueprint = input.adapters.system.createBlueprint(effectiveSource.source)
	if (blueprint.status !== 'valid') return { state: 'invalid', diagnostics: blueprintDiagnostics(blueprint.diagnostics) }

	const boundaryDiagnostics = validateRootShellWriteBoundary(blueprint)
	const variant = selectVariant(input.view, input.context.variantName)
	if (variant.state === 'invalid') return { state: 'invalid', diagnostics: [...boundaryDiagnostics, ...variant.diagnostics] }
	const authoredDiagnostics = validateVariantAuthoring(blueprint, variant.variant, input.context.variantName)
	const preRuntimeDiagnostics = [...boundaryDiagnostics, ...authoredDiagnostics]
	if (preRuntimeDiagnostics.length > 0)
		return { state: 'invalid', diagnostics: deduplicate(preRuntimeDiagnostics) }

	const overrideStateDefaults = mergeRootContextOverrides(input.context, variant.variant)
	const candidate = blueprint.createRuntime({ overrideStateDefaults })
	const runtimeDiagnostics = coreDiagnostics(candidate.getDiagnostics(), '/runtime')
	const diagnostics = runtimeDiagnostics
	if (diagnostics.length > 0) {
		candidate.dispose()
		return { state: 'invalid', diagnostics: deduplicate(diagnostics) }
	}
	return { state: 'ready', runtime: candidate, context: input.context }
}

function selectVariant(view: ViewResource, variantName: string | undefined):
	| Readonly<{ state: 'ready'; variant?: VariantEntry }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }> {
	if (variantName === undefined) return { state: 'ready' }
	const variant = view.variants[variantName]
	if (!variant) return { state: 'invalid', diagnostics: [{ code: 'variant.not_found', path: `/variants/${escapePointer(variantName)}`, message: `Variant ${variantName} does not exist on this View.` }] }
	return { state: 'ready', variant }
}

function validateVariantAuthoring(
	blueprint: ReturnType<RuntimeAdapterBundle['system']['createBlueprint']>,
	variant: VariantEntry | undefined,
	variantName: string | undefined,
): Diagnostic[] {
	if (!variant || !variantName) return []
	const diagnostics: Diagnostic[] = []
	const inspection = inspectBlueprint(blueprint)
	for (const [widgetId, members] of Object.entries(variant.state)) {
		const basePath = `/variants/${escapePointer(variantName)}/state/${escapePointer(widgetId)}`
		if (widgetId === 'root') {
			diagnostics.push({ code: 'variant.root_shell_state_managed', path: basePath, message: 'RootShell presentation State is system-managed and cannot be authored by a Variant.' })
			continue
		}
		const node = blueprint.getWidget(widgetId)
		if (!node || !node.resolved) continue
		const nodeId = inspection.getNodeId(node)
		const inspected = nodeId === null ? null : inspection.getNode(nodeId)
		if (!inspected?.resolved) continue
		const stateMembers = new Map(inspected.state.map(member => [member.name, member] as const))
		for (const member of Object.keys(members)) {
			const state = stateMembers.get(member)
			if (!state || state.authorWritable) continue
			diagnostics.push({
				code: 'variant.state_not_author_writable',
				path: `${basePath}/${escapePointer(member)}`,
				message: `State member ${member} is not declared author-writable by Widget plugin ${inspected.node.type}.`,
			})
		}
	}
	return diagnostics
}

function validateRootShellWriteBoundary(blueprint: Parameters<typeof inspectBlueprint>[0]): Diagnostic[] {
	const inspection = inspectBlueprint(blueprint)
	const diagnostics: Diagnostic[] = []
	for (const node of inspection.nodes) {
		if (!node.resolved || node.nodeId === inspection.rootNodeId) continue
		for (const member of [...node.properties, ...node.methods]) {
			for (const dependency of member.dependencies) {
				if (dependency.status === 'resolved' && dependency.target.nodeId === inspection.rootNodeId
					&& dependency.target.member.type === 'state' && dependency.reference.operation.type === 'state-set') {
					diagnostics.push({ code: 'runtime.root_context_write_forbidden', path: `/ir/${escapePointer(node.node.id)}/${member.type}/${escapePointer(member.name)}`, message: `Widget ${node.node.id} attempts to write UIUX-managed RootShell State ${dependency.target.member.name}.` })
				}
			}
		}
	}
	return diagnostics
}

function mergeRootContextOverrides(context: ResolvedRenderContext, variant: VariantEntry | undefined): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
	return {
		...(variant?.state ?? {}),
		root: {
			locale: context.locale,
			viewport: { id: context.viewportId, width: context.viewport.width, height: context.viewport.height },
			themeId: context.themeId,
			variantName: context.variantName ?? null,
		},
	}
}

function blueprintDiagnostics(diagnostics: readonly { code: string; message: string }[]): Diagnostic[] {
	return diagnostics.map((diagnostic, index) => ({ code: `widget.${diagnostic.code}`, path: `/ir/@diagnostic/${index}`, message: diagnostic.message }))
}

function coreDiagnostics(diagnostics: readonly { code: string; message: string }[], prefix: string): Diagnostic[] {
	return diagnostics.map((diagnostic, index) => ({ code: `widget.${diagnostic.code}`, path: `${prefix}/${index}`, message: diagnostic.message }))
}

function deduplicate(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>()
	return diagnostics.filter(item => {
		const key = `${item.code}\u0000${item.path}\u0000${item.message}`
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}

function withoutVariant(context: ResolvedRenderContext): ResolvedRenderContext {
	return {
		viewId: context.viewId,
		locale: context.locale,
		viewportId: context.viewportId,
		viewport: { ...context.viewport },
		themeId: context.themeId,
	}
}

function escapePointer(value: string): string {
	return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
