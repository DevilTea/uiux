import { resourceIdentityKey } from '../domain/resource-identity'
import { revisionForResourceFiles } from './file-native'
import type { VersionedResourceIdentity, WorkspaceLayout } from './paths'

/** One canonical resource found in a snapshot of the versioned files, with the revision of exactly those bytes. */
export type SnapshotResource = Readonly<{
	kind: string
	key: string
	revision: string
	/** The resource's files by Workspace-relative path. */
	files: ReadonlyMap<string, Uint8Array>
}>

/**
 * Groups a snapshot of the versioned files (path to bytes, as `scanVersionedSnapshotUnlocked`
 * returns it) by the resource the layout classifies each file into. Each resource carries the
 * revision persistence reports for the same bytes; a group without a resource (an Asset directory
 * without `asset.json`) is left out. Rows are sorted by kind, then key, in code unit order.
 */
export function resourcesFromSnapshot(snapshot: ReadonlyMap<string, Uint8Array>, layout: WorkspaceLayout): readonly SnapshotResource[] {
	const groups = new Map<string, { resource: VersionedResourceIdentity; files: Map<string, Uint8Array> }>()
	for (const [path, bytes] of snapshot) {
		const resource = layout.classifyVersionedPath(path)
		if (!resource) continue
		const identity = resourceIdentityKey(resource)
		const group = groups.get(identity) ?? { resource, files: new Map<string, Uint8Array>() }
		group.files.set(path, bytes)
		groups.set(identity, group)
	}
	const resources: SnapshotResource[] = []
	for (const { resource, files } of groups.values()) {
		const revision = revisionForResourceFiles(resource.kind, files)
		if (revision) resources.push({ kind: resource.kind, key: resource.key, revision, files })
	}
	return resources.sort((left, right) => compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.key, right.key))
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}
