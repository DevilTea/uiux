import type { RevisionConflict, RevisionedResourceRead, ResourceRevision } from '../dto/revisions'
import type { Diagnostic } from '../../domain/validation'

/** Persistence-neutral mutable-resource boundary. Atomicity belongs to the implementation. */
export interface MutableResourceRepository<Key, Resource> {
	read(key: Key): Promise<RevisionedResourceRead<Resource> | undefined>
	compareAndSwap(input: Readonly<{
		key: Key
		expectedRevision: ResourceRevision
		resource: Resource
	}>): Promise<
		| Readonly<{ ok: true; revision: ResourceRevision }>
		| Readonly<{ ok: false; conflict: RevisionConflict }>
	>
}

/** Local schema validation is synchronous and never repairs authored values. */
export interface ResourceValidationPort<Resource> {
	validate(resource: Resource): readonly Diagnostic[]
}

/** Cross-resource diagnostics are additive to local schema diagnostics. */
export interface ResourceDiagnosticPort<Key, Resource> {
	/** Report diagnostic findings for the supplied authored candidate without mutating repositories. */
	diagnose(input: Readonly<{ key: Key; resource: Resource }>): Promise<readonly Diagnostic[]>
}

/** Domain transition rules compare authored before/after values without persisting metadata. */
export interface ResourceTransitionValidationPort<Resource> {
	validate(input: Readonly<{ current: Resource; next: Resource }>): readonly Diagnostic[]
}

/** Impact shape is intentionally supplied by the owning domain/analyzer. */
export interface ReferenceImpactAnalyzer<Key, Resource, Impact> {
	analyze(input: Readonly<{
		key: Key
		current: Resource
		next: Resource
	}>): Promise<readonly Impact[]>
}
