import { randomUUID } from 'node:crypto'
import type { ResourceRevision } from '../dto/revisions'
import { summarizeChange, type ChangeSummary } from '../dto/change-summary'
import { analyzeImpact, withResource, type ImpactItem } from '../../domain/impact'
import { flowReferenceDiagnostics } from '../../domain/flows/references'
import { readViewReferenceTarget } from './flow-references'
import { readImpactWorkspaceUnlocked } from './impact-picture'
import { validateResourceRevision } from '../dto/revisions'
import { isFullUuid, type Diagnostic, type JsonObject } from '../../domain/validation'
import { validateFlowResource, type FlowResource, type FlowStep } from '../../domain/flows/schema'
import { trimRequirementIds } from '../../domain/requirements/schema'
import { readRequirementsProvider, requirementListDiagnostics } from './requirements-provider'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type CreateFlowCommand = Readonly<{
	id?: string
	name: string
	scenarioRef?: JsonObject
	entryStepId: string
	steps: Readonly<Record<string, FlowStep>>
	/** Requirement references (Clause 01a18120-f403-…); `create_flow` stores `[]` when omitted. */
	requirements?: readonly string[]
}>

export type UpdateFlowCommand = Readonly<{
	flowId: string
	expectedRevision: string
	name: string
	scenarioRef?: JsonObject
	entryStepId: string
	steps: Readonly<Record<string, FlowStep>>
	/** Omitted, the Flow keeps its requirement references; `[]` clears them (Clause 01a1814f-83f2-…). */
	requirements?: readonly string[]
}>

/** Deletes the whole UX Flow (Clause 01a172ce-ebcc-7a79-8103-ff5339409948). */
export type DeleteFlowCommand = Readonly<{
	flowId: string
	expectedRevision: string
	acknowledgeImpact?: boolean
}>

export type FlowAuthoringResult =
	| Readonly<{ status: 'created' | 'updated'; key: string; revision: ResourceRevision; diagnostics: readonly Diagnostic[]; changeSummary: ChangeSummary }>
	| Readonly<{ status: 'deleted'; key: string; changeSummary: ChangeSummary; impacts?: readonly ImpactItem[] }>
	| Readonly<{ status: 'impact_acknowledgement_required'; key: string; impacts: readonly ImpactItem[] }>
	| Readonly<{ status: 'already_exists'; key: string; currentRevision?: ResourceRevision }>
	| Readonly<{ status: 'not_found'; key: string }>
	| Readonly<{ status: 'conflict'; key: string; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: string; diagnostics: readonly Diagnostic[] }>

export type FlowAuthoringService = Readonly<{
	createFlow(command: CreateFlowCommand): Promise<FlowAuthoringResult>
	updateFlow(command: UpdateFlowCommand): Promise<FlowAuthoringResult>
	deleteFlow(command: DeleteFlowCommand): Promise<FlowAuthoringResult>
}>

export function createFlowAuthoringService(persistence: FileNativePersistence): FlowAuthoringService {
	/**
	 * Clause 01a172e8-906d-779b-8305-870bf5f09e75: a result's diagnostics are the Flow's structural
	 * diagnostics followed by its reference diagnostics, as `validate_flow` reports them. A reference
	 * that dangles never refuses a save (Rule 01a1144e-5101-78bb-9748-5bdabb1c013b).
	 */
	async function withReferenceDiagnostics(flow: FlowResource, structural: readonly Diagnostic[]): Promise<readonly Diagnostic[]> {
		const references = await flowReferenceDiagnostics(flow, viewId => readViewReferenceTarget(persistence, viewId))
		// Clause 01a18120-f5b9-…: an ID the `spec` provider lacks is reported, never refused.
		const ids = flow.requirements ?? []
		const requirements = ids.length === 0
			? []
			: requirementListDiagnostics(await readRequirementsProvider(persistence.root, (await persistence.workspace.readInspected()).resource?.requirements), [[ids, '/requirements']])
		return references.length + requirements.length > 0 ? [...structural, ...references, ...requirements] : structural
	}

	async function createFlow(command: CreateFlowCommand): Promise<FlowAuthoringResult> {
		const id = command.id ?? randomUUID()
		const resource: FlowResource = {
			id,
			name: command.name,
			...(command.scenarioRef ? { scenarioRef: command.scenarioRef } : {}),
			entryStepId: command.entryStepId,
			steps: command.steps,
			requirements: trimRequirementIds(command.requirements ?? []),
		}
		const validation = validateFlowResource(resource)
		if (!validation.ok)
			return { status: 'invalid', key: id, diagnostics: validation.diagnostics }

		try {
			const revision = await persistence.flows.create(id, resource)
			const inspected = await persistence.flows.readInspected(id)
			return { status: 'created', key: id, revision, diagnostics: await withReferenceDiagnostics(resource, inspected?.diagnostics ?? []), changeSummary: summarizeChange(undefined, resource) }
		}
		catch (error) {
			if (!(error instanceof PersistenceError) || error.code !== 'persistence.resource_exists') throw error
			const currentRevision = await persistence.flows.readRevision(id)
			return { status: 'already_exists', key: id, ...(currentRevision ? { currentRevision } : {}) }
		}
	}

	async function updateFlow(command: UpdateFlowCommand): Promise<FlowAuthoringResult> {
		if (!isFullUuid(command.flowId))
			return {
				status: 'invalid',
				key: command.flowId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/flowId', message: 'Flow id must be a full UUID.' }],
			}

		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.flowId, diagnostics: expectedRevision.diagnostics }

		const current = await persistence.flows.read(command.flowId)
		if (!current) return { status: 'not_found', key: command.flowId }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.flowId, currentRevision: current.revision }

		const next: FlowResource = {
			id: command.flowId,
			name: command.name,
			...(command.scenarioRef ? { scenarioRef: command.scenarioRef } : {}),
			entryStepId: command.entryStepId,
			steps: command.steps,
			requirements: command.requirements === undefined ? current.resource.requirements ?? [] : trimRequirementIds(command.requirements),
		}
		const validation = validateFlowResource(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.flowId, diagnostics: validation.diagnostics }

		const commit = await persistence.flows.compareAndSwap({
			key: command.flowId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.flowId, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.flows.readInspected(command.flowId)
		return { status: 'updated', key: command.flowId, revision: commit.revision, diagnostics: await withReferenceDiagnostics(next, inspected?.diagnostics ?? []), changeSummary: summarizeChange(current.resource, next) }
	}

	/**
	 * Clause 01a172ce-ebcc-7a79-8103-ff5339409948: deletes the whole Flow and nothing else; a non-empty
	 * reference impact is deleted only when acknowledged (Clause 01a172ce-bdef-7cf6-bf8c-770dc9dd5e34).
	 */
	async function deleteFlow(command: DeleteFlowCommand): Promise<FlowAuthoringResult> {
		if (!isFullUuid(command.flowId))
			return {
				status: 'invalid',
				key: command.flowId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/flowId', message: 'Flow id must be a full UUID.' }],
			}
		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.flowId, diagnostics: expectedRevision.diagnostics }
		const current = await persistence.flows.read(command.flowId)
		if (!current) return { status: 'not_found', key: command.flowId }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.flowId, currentRevision: current.revision }

		let impacts: readonly ImpactItem[] = []
		const deleted = await persistence.flows.deleteIfRevision<{ impacts: readonly ImpactItem[] }>({ key: command.flowId, expectedRevision: expectedRevision.value, guard: async () => {
				// Inside the exclusive lock, so a reference added since the first look is never missed.
				const before = await readImpactWorkspaceUnlocked(persistence)
				impacts = analyzeImpact(before, withResource(before, { kind: 'flow', key: command.flowId }, undefined, undefined))
				return impacts.length > 0 && command.acknowledgeImpact !== true ? { impacts } : undefined
			} })
		switch (deleted.status) {
			case 'refused': return { status: 'impact_acknowledgement_required', key: command.flowId, impacts: deleted.refusal.impacts }
			case 'conflict': return { status: 'conflict', key: command.flowId, currentRevision: deleted.currentRevision }
			case 'deleted': return { status: 'deleted', key: command.flowId, changeSummary: summarizeChange(current.resource, undefined), ...(impacts.length > 0 ? { impacts } : {}) }
			default: return { status: 'not_found', key: command.flowId }
		}
	}

	return { createFlow, updateFlow, deleteFlow }
}
