import type { ResourceRevision } from '../dto/revisions'
import { summarizeChange, type ChangeSummary } from '../dto/change-summary'
import { validateResourceRevision } from '../dto/revisions'
import { transitionDecision, type Decision, type DecisionActor, type DecisionOutcome, type DecisionStatus, type Reference, type ViewSpec } from '../../domain/spec/schema'
import { isFullUuid, type Diagnostic } from '../../domain/validation'
import { validateViewResource, type ViewResource } from '../../domain/views/schema'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type ViewSpecContent = Readonly<{
	intent: string
	entryConditions: readonly string[]
	interactionRules: readonly string[]
	constraints: readonly string[]
	accessibility: readonly string[]
	references: readonly Reference[]
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
	| Readonly<{ status: 'created' | 'updated'; key: string; revision: ResourceRevision; diagnostics: readonly Diagnostic[]; changeSummary: ChangeSummary; decision?: Decision }>
	| Readonly<{ status: 'already_exists'; key: string; currentRevision?: ResourceRevision }>
	| Readonly<{ status: 'not_found'; key: string }>
	| Readonly<{ status: 'conflict'; key: string; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: string; diagnostics: readonly Diagnostic[] }>

export type ViewAuthoringService = Readonly<{
	createView(command: CreateViewCommand): Promise<ViewAuthoringResult>
	updateViewSpec(command: UpdateViewSpecCommand): Promise<ViewAuthoringResult>
	updateViewStructure(command: UpdateViewStructureCommand): Promise<ViewAuthoringResult>
	updateViewMetadata(command: UpdateViewMetadataCommand): Promise<ViewAuthoringResult>
	deferDecision(command: DecisionLifecycleCommand): Promise<ViewAuthoringResult>
	decideDecision(command: DecideDecisionCommand): Promise<ViewAuthoringResult>
	reopenDecision(command: DecisionLifecycleCommand): Promise<ViewAuthoringResult>
}>

export function createViewAuthoringService(persistence: FileNativePersistence): ViewAuthoringService {
	async function createView(command: CreateViewCommand): Promise<ViewAuthoringResult> {
		const resource: ViewResource = {
			id: command.id,
			name: command.name,
			...(command.feature === undefined ? {} : { feature: command.feature }),
			ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
			variants: {},
			spec: withPreservedDecisions(command.spec, []),
		}
		const validation = validateViewResource(resource)
		if (!validation.ok)
			return { status: 'invalid', key: command.id, diagnostics: validation.diagnostics }

		try {
			const revision = await persistence.views.create(command.id, resource)
			const inspected = await persistence.views.readInspected(command.id)
			return { status: 'created', key: command.id, revision, diagnostics: inspected?.diagnostics ?? [], changeSummary: summarizeChange(undefined, resource) }
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
			spec: withPreservedDecisions(command.spec, current.resource.spec.decisions),
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
			variants: command.variants,
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
		updateViewMetadata,
		deferDecision: command => transition(command, 'deferred'),
		decideDecision: command => transition(command, 'decided', command.outcome),
		reopenDecision: command => transition(command, 'pending'),
	}
}

/** A non-string is passed through so the View validator reports it. */
function trimmed(value: string): string {
	return typeof value === 'string' ? value.trim() : value
}

function withPreservedDecisions(content: ViewSpecContent, decisions: ViewSpec['decisions']): ViewSpec {
	return {
		intent: content.intent,
		entryConditions: content.entryConditions,
		interactionRules: content.interactionRules,
		constraints: content.constraints,
		accessibility: content.accessibility,
		references: content.references,
		decisions,
	}
}
