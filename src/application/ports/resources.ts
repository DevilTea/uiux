import type { RevisionConflict, RevisionedResourceRead, ResourceRevision } from '../dto/revisions'

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
