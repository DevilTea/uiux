import { randomUUID } from 'node:crypto'
import type { ResourceRevision } from '../dto/revisions'
import { validateResourceRevision } from '../dto/revisions'
import { isFullUuid, type Diagnostic, type JsonObject } from '../../domain/validation'
import { validateFlowResource, type FlowResource, type FlowStep } from '../../domain/flows/schema'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type CreateFlowCommand = Readonly<{
	id?: string
	name: string
	scenarioRef?: JsonObject
	entryStepId: string
	steps: Readonly<Record<string, FlowStep>>
}>

export type UpdateFlowCommand = Readonly<{
	flowId: string
	expectedRevision: string
	name: string
	scenarioRef?: JsonObject
	entryStepId: string
	steps: Readonly<Record<string, FlowStep>>
}>

export type FlowAuthoringResult =
	| Readonly<{ status: 'created' | 'updated'; key: string; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'already_exists'; key: string; currentRevision?: ResourceRevision }>
	| Readonly<{ status: 'not_found'; key: string }>
	| Readonly<{ status: 'conflict'; key: string; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: string; diagnostics: readonly Diagnostic[] }>

export type FlowAuthoringService = Readonly<{
	createFlow(command: CreateFlowCommand): Promise<FlowAuthoringResult>
	updateFlow(command: UpdateFlowCommand): Promise<FlowAuthoringResult>
}>

export function createFlowAuthoringService(persistence: FileNativePersistence): FlowAuthoringService {
	async function createFlow(command: CreateFlowCommand): Promise<FlowAuthoringResult> {
		const id = command.id ?? randomUUID()
		const resource: FlowResource = {
			id,
			name: command.name,
			...(command.scenarioRef ? { scenarioRef: command.scenarioRef } : {}),
			entryStepId: command.entryStepId,
			steps: command.steps,
		}
		const validation = validateFlowResource(resource)
		if (!validation.ok)
			return { status: 'invalid', key: id, diagnostics: validation.diagnostics }

		try {
			const revision = await persistence.flows.create(id, resource)
			const inspected = await persistence.flows.readInspected(id)
			return { status: 'created', key: id, revision, diagnostics: inspected?.diagnostics ?? [] }
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
		return { status: 'updated', key: command.flowId, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
	}

	return { createFlow, updateFlow }
}
