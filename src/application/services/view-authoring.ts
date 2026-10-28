import type { ResourceRevision } from '../dto/revisions'
import { summarizeChange, type ChangeSummary } from '../dto/change-summary'
import { analyzeImpact, variantImpact, withResource, type ImpactItem } from '../../domain/impact'
import { nextSingleFileRevision, readImpactWorkspace, readImpactWorkspaceUnlocked } from './impact-picture'
import { validateResourceRevision } from '../dto/revisions'
import { transitionDecision, type Decision, type DecisionActor, type DecisionOutcome, type DecisionStatus, type Reference, type ViewSpec } from '../../domain/spec/schema'
import { isFullUuid, type Diagnostic } from '../../domain/validation'
import { validateViewResource, type ViewResource } from '../../domain/views/schema'
import { trimRequirementIds } from '../../domain/requirements/schema'
import { readRequirementsProvider, requirementListDiagnostics } from './requirements-provider'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type ViewSpecContent = Readonly<{
	intent: string
	entryConditions: readonly string[]
	interactionRules: readonly string[]
	constraints: readonly string[]
	accessibility: readonly string[]
	references: readonly Reference[]
	/**
	 * Requirement references (Clause 01a18120-f403-…). Omitted, `create_view` stores `[]` and an update
	 * keeps the existing ones; `[]` clears them (Clause 01a1814f-83f2-…).
	 */
	requirements?: readonly string[]
}>

export type CreateViewCommand = Readonly<{
	id: string
	name: string
	feature?: string
	spec: ViewSpecContent
}>

export type UpdateViewSpecCommand = Readonly<{
	key: string
	expectedRevision: string
	spec: ViewSpecContent
}>

export type UpdateViewStructureCommand = Readonly<{
	key: string
	expectedRevision: string
	ir: ViewResource['ir']
	variants: ViewResource['variants']
	/** Acknowledges the impact of removing a Variant name (Clause 01a172ce-bdef-7cf6-bf8c-770dc9dd5e34). */
	acknowledgeImpact?: boolean
}>

/** Deletes the whole View (Clause 01a172ce-ebcc-7a79-8103-ff5339409948). */
export type DeleteViewCommand = Readonly<{
	key: string
	expectedRevision: string
	acknowledgeImpact?: boolean
}>

/**
 * The View metadata operation (Clause 01a15379-d8f7-7c0c-9b9a-05c07c64cc85): `name` and `feature`
 * only, at least one of them. An omitted member keeps its value; `feature: null` removes the tag.
 */
export type UpdateViewMetadataCommand = Readonly<{
	key: string
	expectedRevision: string
	name?: string
	feature?: string | null
}>

/**
 * A Decision lifecycle action (Clause 01a17226-fafc-7691-99ff-aa3b20f5836f): `key` is the View's,
 * `expectedRevision` the View's. `actor` and `at` are stamped by the scoped session.
 */
export type DecisionLifecycleCommand = Readonly<{
	key: string
	decisionId: string
	expectedRevision: string
	actor?: DecisionActor
	at?: string
}>
export type DecideDecisionCommand = DecisionLifecycleCommand & Readonly<{ outcome: DecisionOutcome }>

export type ViewAuthoringResult =
	| Readonly<{ status: 'created' | 'updated'; key: string; revision: ResourceRevision; diagnostics: readonly Diagnostic[]; changeSummary: ChangeSummary; decision?: Decision; impacts?: readonly ImpactItem[] }>
	| Readonly<{ status: 'deleted'; key: string; changeSummary: ChangeSummary; impacts?: readonly ImpactItem[] }>
	| Readonly<{ status: 'impact_acknowledgement_required'; key: string; impacts: readonly ImpactItem[] }>
	| Readonly<{ status: 'already_exists'; key: string; currentRevision?: ResourceRevision }>
	| Readonly<{ status: 'not_found'; key: string }>
	| Readonly<{ status: 'conflict'; key: string; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: string; diagnostics: readonly Diagnostic[] }>

export type ViewAuthoringService = Readonly<{
	createView(command: CreateViewCommand): Promise<ViewAuthoringResult>
	updateViewSpec(command: UpdateViewSpecCommand): Promise<ViewAuthoringResult>
	updateViewStructure(command: UpdateViewStructureCommand): Promise<ViewAuthoringResult>
	deleteView(command: DeleteViewCommand): Promise<ViewAuthoringResult>
	updateViewMetadata(command: UpdateViewMetadataCommand): Promise<ViewAuthoringResult>
	deferDecision(command: DecisionLifecycleCommand): Promise<ViewAuthoringResult>
	decideDecision(command: DecideDecisionCommand): Promise<ViewAuthoringResult>
	reopenDecision(command: DecisionLifecycleCommand): Promise<ViewAuthoringResult>
}>

export function createViewAuthoringService(persistence: FileNativePersistence): ViewAuthoringService {
	/**
	 * Clause 01a18120-f5b9-…: the diagnostics a write's result adds to the resource's own: each ID of the
	 * View's Spec and Variants the `spec` provider lacks is `requirements.unresolved`, an unreadable
	 * provider is `requirements.provider_unavailable`. The write has already succeeded and kept every ID.
	 */
	async function withRequirementDiagnostics(view: ViewResource, base: readonly Diagnostic[]): Promise<readonly Diagnostic[]> {
		const lists: [readonly string[], string][] = [[view.spec?.requirements ?? [], '/spec/requirements']]
		for (const [name, entry] of Object.entries(view.variants ?? {})) lists.push([entry.requirements ?? [], `/variants/${name.replaceAll('~', '~0').replaceAll('/', '~1')}/requirements`])
		if (lists.every(([ids]) => ids.length === 0)) return base
		const setting = (await persistence.workspace.readInspected()).resource?.requirements
		const added = requirementListDiagnostics(await readRequirementsProvider(persistence.root, setting), lists)
		return added.length > 0 ? [...base, ...added] : base
	}

	async function createView(command: CreateViewCommand): Promise<ViewAuthoringResult> {
		const resource: ViewResource = {
			id: command.id,
			name: command.name,
			...(command.feature === undefined ? {} : { feature: command.feature }),
			ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
			variants: {},
			spec: withPreservedDecisions(command.spec, [], trimRequirementIds(command.spec.requirements ?? [])),
		}
		const validation = validateViewResource(resource)
		if (!validation.ok)
			return { status: 'invalid', key: command.id, diagnostics: validation.diagnostics }

		try {
			const revision = await persistence.views.create(command.id, resource)
			const inspected = await persistence.views.readInspected(command.id)
			return { status: 'created', key: command.id, revision, diagnostics: await withRequirementDiagnostics(resource, inspected?.diagnostics ?? []), changeSummary: summarizeChange(undefined, resource) }
		}
		catch (error) {
			if (!(error instanceof PersistenceError) || error.code !== 'persistence.resource_exists') throw error
			const currentRevision = await persistence.views.readRevision(command.id)
			return { status: 'already_exists', key: command.id, ...(currentRevision ? { currentRevision } : {}) }
		}
	}

	async function updateViewSpec(command: UpdateViewSpecCommand): Promise<ViewAuthoringResult> {
		if (!isFullUuid(command.key))
			return {
				status: 'invalid',
				key: command.key,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/viewId', message: 'View id must be a full UUID.' }],
			}
		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.key, diagnostics: expectedRevision.diagnostics }
		const current = await persistence.views.read(command.key)
		if (!current) return { status: 'not_found', key: command.key }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.key, currentRevision: current.revision }

		const next: ViewResource = {
			...current.resource,
			// Clause 01a1814f-83f2-…: omitted `requirements` keeps the existing references, `[]` clears them.
			spec: withPreservedDecisions(command.spec, current.resource.spec.decisions, command.spec.requirements === undefined ? current.resource.spec.requirements ?? [] : trimRequirementIds(command.spec.requirements)),
		}
		const validation = validateViewResource(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.key, diagnostics: validation.diagnostics }

		const commit = await persistence.views.compareAndSwap({
			key: command.key,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.key, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.views.readInspected(command.key)
		return { status: 'updated', key: command.key, revision: commit.revision, diagnostics: await withRequirementDiagnostics(next, inspected?.diagnostics ?? []), changeSummary: summarizeChange(current.resource, next) }
	}

	async function updateViewStructure(command: UpdateViewStructureCommand): Promise<ViewAuthoringResult> {
		if (!isFullUuid(command.key))
			return {
				status: 'invalid',
				key: command.key,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/viewId', message: 'View id must be a full UUID.' }],
			}
		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.key, diagnostics: expectedRevision.diagnostics }
		const current = await persistence.views.read(command.key)
		if (!current) return { status: 'not_found', key: command.key }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.key, currentRevision: current.revision }

		const next: ViewResource = {
			...current.resource,
			ir: command.ir,
			variants: variantsKeepingRequirements(command.variants, current.resource.variants),
		}
		const validation = validateViewResource(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.key, diagnostics: validation.diagnostics }

		// Rule 01a172ce-2b4d-70dc-ab08-bd22c71fd1c7: a Variant name present before and absent after is
		// renamed or removed, and what names it needs the caller's acknowledgement.
		let impacts: readonly ImpactItem[] = []
		if (removesVariantName(current.resource, next)) {
			const before = await readImpactWorkspace(persistence)
			impacts = variantImpact(before, withResource(before, { kind: 'view', key: command.key }, next, nextSingleFileRevision('view', next)))
			if (impacts.length > 0 && command.acknowledgeImpact !== true)
				return { status: 'impact_acknowledgement_required', key: command.key, impacts }
		}

		const commit = await persistence.views.compareAndSwap({
			key: command.key,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.key, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.views.readInspected(command.key)
		return { status: 'updated', key: command.key, revision: commit.revision, diagnostics: await withRequirementDiagnostics(next, inspected?.diagnostics ?? []), changeSummary: summarizeChange(current.resource, next), ...(impacts.length > 0 ? { impacts } : {}) }
	}

	/**
	 * Clause 01a172ce-ebcc-7a79-8103-ff5339409948: deletes the whole View and nothing else. The impact on
	 * what names the View (Rule 01a172ce-280b-7cec-9ca5-ec189b313ebe) is analyzed first; a non-empty one
	 * is deleted only when acknowledged, and no referencing resource is cascaded, rebound or rewritten.
	 */
	async function deleteView(command: DeleteViewCommand): Promise<ViewAuthoringResult> {
		if (!isFullUuid(command.key))
			return {
				status: 'invalid',
				key: command.key,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/viewId', message: 'View id must be a full UUID.' }],
			}
		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.key, diagnostics: expectedRevision.diagnostics }
		const current = await persistence.views.read(command.key)
		if (!current) return { status: 'not_found', key: command.key }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.key, currentRevision: current.revision }

		let impacts: readonly ImpactItem[] = []
		const deleted = await persistence.views.deleteIfRevision<{ impacts: readonly ImpactItem[] }>({ key: command.key, expectedRevision: expectedRevision.value, guard: async () => {
				// Inside the exclusive lock, so a reference added since the first look is never missed.
				const before = await readImpactWorkspaceUnlocked(persistence)
				impacts = analyzeImpact(before, withResource(before, { kind: 'view', key: command.key }, undefined, undefined))
				return impacts.length > 0 && command.acknowledgeImpact !== true ? { impacts } : undefined
			} })
		switch (deleted.status) {
			case 'refused': return { status: 'impact_acknowledgement_required', key: command.key, impacts: deleted.refusal.impacts }
			case 'conflict': return { status: 'conflict', key: command.key, currentRevision: deleted.currentRevision }
			case 'deleted': return { status: 'deleted', key: command.key, changeSummary: summarizeChange(current.resource, undefined), ...(impacts.length > 0 ? { impacts } : {}) }
			default: return { status: 'not_found', key: command.key }
		}
	}

	/**
	 * Clause 01a15379-d8f7-7c0c-9b9a-05c07c64cc85: changes only `name` (stored trimmed) and `feature`
	 * (`null` removes it), with the same revision check, validation and result as the other View
	 * writes. The edit lease is checked by the scoped session before this runs.
	 */
	async function updateViewMetadata(command: UpdateViewMetadataCommand): Promise<ViewAuthoringResult> {
		if (!isFullUuid(command.key))
			return {
				status: 'invalid',
				key: command.key,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/viewId', message: 'View id must be a full UUID.' }],
			}
		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.key, diagnostics: expectedRevision.diagnostics }
		if (command.name === undefined && command.feature === undefined)
			return {
				status: 'invalid',
				key: command.key,
				diagnostics: [{ code: 'schema.required_field', path: '/name', message: 'Give at least one of name and feature.' }],
			}
		const current = await persistence.views.read(command.key)
		if (!current) return { status: 'not_found', key: command.key }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.key, currentRevision: current.revision }

		const { feature: currentFeature, ...rest } = current.resource
		const feature = command.feature === undefined ? currentFeature : command.feature
		const next: ViewResource = {
			...rest,
			name: command.name === undefined ? current.resource.name : trimmed(command.name),
			...(feature === null || feature === undefined ? {} : { feature }),
		}
		const validation = validateViewResource(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.key, diagnostics: validation.diagnostics }

		const commit = await persistence.views.compareAndSwap({
			key: command.key,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.key, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.views.readInspected(command.key)
		return { status: 'updated', key: command.key, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [], changeSummary: summarizeChange(current.resource, next) }
	}

	/**
	 * Clause 01a17226-fafc-7691-99ff-aa3b20f5836f: one explicit transition of one Decision in the View's
	 * Spec, under the View's `expectedRevision` (the edit lease is checked by the scoped session). The
	 * Decision keeps its identity and position; `transitionDecision` appends the history entry, and a
	 * reopen clears the current outcome.
	 */
	async function transition(command: DecisionLifecycleCommand, nextStatus: DecisionStatus, outcome?: DecisionOutcome): Promise<ViewAuthoringResult> {
		if (!isFullUuid(command.key))
			return { status: 'invalid', key: command.key, diagnostics: [{ code: 'identity.invalid_uuid', path: '/viewId', message: 'View id must be a full UUID.' }] }
		if (!isFullUuid(command.decisionId))
			return { status: 'invalid', key: command.key, diagnostics: [{ code: 'identity.invalid_uuid', path: '/decisionId', message: 'Decision id must be a full UUID.' }] }
		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.key, diagnostics: expectedRevision.diagnostics }
		if (nextStatus === 'decided') {
			const shape = outcome as { summary?: unknown; rationale?: unknown } | undefined
			if (typeof shape !== 'object' || shape === null || typeof shape.summary !== 'string' || typeof shape.rationale !== 'string')
				return { status: 'invalid', key: command.key, diagnostics: [{ code: 'decision.missing_outcome', path: '/outcome', message: 'Deciding requires an outcome with a non-empty summary and a rationale string.' }] }
			if (shape.summary.trim().length === 0)
				return { status: 'invalid', key: command.key, diagnostics: [{ code: 'decision.empty_outcome_summary', path: '/outcome/summary', message: 'A decided outcome summary cannot contain only whitespace.' }] }
		}
		const current = await persistence.views.read(command.key)
		if (!current) return { status: 'not_found', key: command.key }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.key, currentRevision: current.revision }

		const decisions = current.resource.spec.decisions ?? []
		const index = decisions.findIndex(decision => decision.id === command.decisionId)
		if (index < 0) return { status: 'not_found', key: command.decisionId }
		const transitioned = transitionDecision(decisions[index]!, {
			nextStatus,
			at: command.at ?? new Date().toISOString(),
			actor: command.actor as DecisionActor,
			...(outcome === undefined ? {} : { outcome }),
		})
		if (!transitioned.ok)
			return { status: 'invalid', key: command.key, diagnostics: transitioned.diagnostics }

		const next: ViewResource = {
			...current.resource,
			spec: { ...current.resource.spec, decisions: decisions.map((decision, at) => at === index ? transitioned.value : decision) },
		}
		const validation = validateViewResource(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.key, diagnostics: validation.diagnostics }

		const commit = await persistence.views.compareAndSwap({
			key: command.key,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.key, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.views.readInspected(command.key)
		return { status: 'updated', key: command.key, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [], decision: transitioned.value, changeSummary: summarizeChange(current.resource, next) }
	}

	return {
		createView,
		updateViewSpec,
		updateViewStructure,
		deleteView,
		updateViewMetadata,
		deferDecision: command => transition(command, 'deferred'),
		decideDecision: command => transition(command, 'decided', command.outcome),
		reopenDecision: command => transition(command, 'pending'),
	}
}

/** Whether the write drops a Variant name the View has now. */
function removesVariantName(current: ViewResource, next: ViewResource): boolean {
	const kept = new Set(Object.keys(next.variants ?? {}))
	return Object.keys(current.variants ?? {}).some(name => !kept.has(name))
}

/** A non-string is passed through so the View validator reports it. */
function trimmed(value: string): string {
	return typeof value === 'string' ? value.trim() : value
}

/**
 * Clause 01a1814f-83f2-76d7-8a6d-c365b548c21c: each Variant entry of a structure write keeps the
 * `requirements` the View's entry of the same name has when it gives none, trims the ones it gives
 * (`[]` clears them), and an entry of a new name starts with none. An entry that is not an object is
 * passed through, so the View validator reports it.
 */
function variantsKeepingRequirements(next: ViewResource['variants'], current: ViewResource['variants'] | undefined): ViewResource['variants'] {
	if (typeof next !== 'object' || next === null || Array.isArray(next)) return next
	return Object.fromEntries(Object.entries(next).map(([name, entry]) => {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [name, entry]
		if (Object.hasOwn(entry, 'requirements')) return [name, { ...entry, requirements: trimRequirementIds(entry.requirements) }]
		const kept = current && Object.hasOwn(current, name) ? current[name]?.requirements : undefined
		return [name, kept === undefined ? entry : { ...entry, requirements: kept }]
	}))
}

function withPreservedDecisions(content: ViewSpecContent, decisions: ViewSpec['decisions'], requirements: readonly string[]): ViewSpec {
	return {
		intent: content.intent,
		entryConditions: content.entryConditions,
		interactionRules: content.interactionRules,
		constraints: content.constraints,
		accessibility: content.accessibility,
		references: content.references,
		requirements,
		decisions,
	}
}
