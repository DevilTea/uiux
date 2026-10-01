import { Validator, type ValidationResult } from '../../domain/validation'

/** Opaque read-time revision; it is not authored or persisted in a resource. */
export type ResourceRevision = string & { readonly __resourceRevision: unique symbol }

/** Application/query envelope, kept outside canonical persisted resource DTOs. */
export type RevisionedResourceRead<Resource> = Readonly<{
	resource: Resource
	revision: ResourceRevision
}>

/** Every mutation names the revision it observed before attempting a write. */
export type ExpectedRevisionMutation<Command> = Readonly<{
	command: Command
	expectedRevision: ResourceRevision
}>

export type RevisionConflict = Readonly<{
	code: 'revision_conflict'
	currentRevision: ResourceRevision
}>

export function validateResourceRevision(value: unknown, path = ''): ValidationResult<ResourceRevision> {
	const v = new Validator()
	v.string(value, path, true)
	return v.finish<ResourceRevision>(value)
}

export function validateRevisionConflict(input: unknown, path = ''): ValidationResult<RevisionConflict> {
	const v = new Validator()
	const conflict = v.object(input, path)
	if (!conflict) return v.finish<RevisionConflict>(input)
	if (conflict.code !== 'revision_conflict')
		v.issue('revision.invalid_conflict_code', `${path}/code`, 'Expected the structured revision-conflict code.')
	v.string(conflict.currentRevision, `${path}/currentRevision`, true)
	return v.finish<RevisionConflict>(input)
}
