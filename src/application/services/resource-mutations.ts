import { validateResourceRevision, type ResourceRevision } from '../dto/revisions'
import type {
	MutableResourceRepository,
	ReferenceImpactAnalyzer,
	ResourceDiagnosticPort,
	ResourceTransitionValidationPort,
	ResourceValidationPort,
} from '../ports/resources'
import type { Diagnostic } from '../../domain/validation'

export type ResourceReadResult<Resource> = Readonly<{
	resource: Resource
	revision: ResourceRevision
	diagnostics: readonly Diagnostic[]
}>

export type ResourceMutationCommand<Key, Resource> = Readonly<{
	key: Key
	expectedRevision: ResourceRevision
	mutate(current: Resource): Resource
	changeSummary: readonly string[]
	acknowledgeImpact?: boolean
}>

export type ResourceMutationResult<Key, Impact = never> =
	| Readonly<{ status: 'updated'; key: Key; revision: ResourceRevision; diagnostics: readonly Diagnostic[]; changeSummary: readonly string[] }>
	| Readonly<{ status: 'not_found'; key: Key }>
	| Readonly<{ status: 'invalid_expected_revision'; key: Key; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'conflict'; key: Key; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid'; key: Key; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'impact_acknowledgement_required'; key: Key; impacts: readonly Impact[] }>

export type ResourceService<Key, Resource, Impact> = Readonly<{
	read(key: Key): Promise<ResourceReadResult<Resource> | undefined>
	mutate(command: ResourceMutationCommand<Key, Resource>): Promise<ResourceMutationResult<Key, Impact>>
}>

/** Internal mutation kernel shared by domain-specific application services. */
export function createResourceService<Key, Resource, Impact>(input: Readonly<{
	repository: MutableResourceRepository<Key, Resource>
	validation: ResourceValidationPort<Resource>
	diagnostics?: ResourceDiagnosticPort<Key, Resource>
	transitionValidation?: ResourceTransitionValidationPort<Resource>
	impact: ReferenceImpactAnalyzer<Key, Resource, Impact>
}>): ResourceService<Key, Resource, Impact> {
	async function read(key: Key): Promise<ResourceReadResult<Resource> | undefined> {
		const current = await input.repository.read(key)
		if (!current) return undefined
		const diagnostics = [
			...input.validation.validate(current.resource),
			...(input.diagnostics ? await input.diagnostics.diagnose({ key, resource: current.resource }) : []),
		]
		return { ...current, diagnostics }
	}

	async function mutate(command: ResourceMutationCommand<Key, Resource>): Promise<ResourceMutationResult<Key, Impact>> {
		const revision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!revision.ok)
			return { status: 'invalid_expected_revision', key: command.key, diagnostics: revision.diagnostics }

		const current = await input.repository.read(command.key)
		if (!current) return { status: 'not_found', key: command.key }
		if (current.revision !== command.expectedRevision)
			return { status: 'conflict', key: command.key, currentRevision: current.revision }

		const next = command.mutate(current.resource)
		const diagnostics = [
			...input.validation.validate(next),
			...(input.transitionValidation?.validate({ current: current.resource, next }) ?? []),
		]
		if (diagnostics.length > 0)
			return { status: 'invalid', key: command.key, diagnostics }

		const candidateDiagnostics = input.diagnostics
			? await input.diagnostics.diagnose({ key: command.key, resource: next })
			: []
		const impacts = await input.impact.analyze({ key: command.key, current: current.resource, next })
		if (impacts.length > 0 && command.acknowledgeImpact !== true)
			return { status: 'impact_acknowledgement_required', key: command.key, impacts }

		const commit = await input.repository.compareAndSwap({
			key: command.key,
			expectedRevision: command.expectedRevision,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.key, currentRevision: commit.conflict.currentRevision }

		return {
			status: 'updated',
			key: command.key,
			revision: commit.revision,
			diagnostics: candidateDiagnostics,
			changeSummary: command.changeSummary,
		}
	}

	return { read, mutate }
}
