import type { ResourceRevision } from '../dto/revisions'
import { validateResourceRevision } from '../dto/revisions'
import type { Reference, ViewSpec } from '../../domain/spec/schema'
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

export type ViewAuthoringResult =
	| Readonly<{ status: 'created' | 'updated'; key: string; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'already_exists'; key: string; currentRevision?: ResourceRevision }>
	| Readonly<{ status: 'not_found'; key: string }>
	| Readonly<{ status: 'conflict'; key: string; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: string; diagnostics: readonly Diagnostic[] }>

export type ViewAuthoringService = Readonly<{
	createView(command: CreateViewCommand): Promise<ViewAuthoringResult>
	updateViewSpec(command: UpdateViewSpecCommand): Promise<ViewAuthoringResult>
	updateViewStructure(command: UpdateViewStructureCommand): Promise<ViewAuthoringResult>
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
			return { status: 'created', key: command.id, revision, diagnostics: inspected?.diagnostics ?? [] }
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
		return { status: 'updated', key: command.key, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
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
		return { status: 'updated', key: command.key, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
	}

	return { createView, updateViewSpec, updateViewStructure }
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
