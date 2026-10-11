import type { HistoryResourceEntry } from '../../domain/history/schema'
import { resourceIdentityKey } from '../../domain/history/summary'
import { revisionForResourceFiles } from '../file-native'
import type { VersionedResourceIdentity, WorkspaceLayout } from '../paths'
import { blobDigest } from './host-store'
import { compareCodeUnits } from './order'

export type VersionResources = Readonly<{
	/** The version's `resources` (Clause 01a11a5e-1fc4-7bf0-a402-61c345f454c2), sorted by kind, then key. */
	resources: readonly HistoryResourceEntry[]
	/** The bytes behind every digest the resources name, for the store that keeps the blobs. */
	blobs: ReadonlyMap<string, Uint8Array>
}>

/**
 * Turns a snapshot of the versioned files (path → bytes, as `scanVersionedSnapshotUnlocked`
 * returns it) into a version's `resources` and blobs. Files are grouped by the resource the
 * layout classifies them into, and each resource carries the revision persistence reports for the
 * same bytes; a group without a resource (an Asset directory without `asset.json`) is left out.
 */
export function versionResourcesFromSnapshot(snapshot: ReadonlyMap<string, Uint8Array>, layout: WorkspaceLayout): VersionResources {
	const groups = new Map<string, { resource: VersionedResourceIdentity; files: Map<string, Uint8Array> }>()
	for (const [path, bytes] of snapshot) {
		const resource = layout.classifyVersionedPath(path)
		if (!resource) continue
		const key = resourceIdentityKey(resource)
		const group = groups.get(key) ?? { resource, files: new Map<string, Uint8Array>() }
		group.files.set(path, bytes)
		groups.set(key, group)
	}
	const resources: HistoryResourceEntry[] = []
	const blobs = new Map<string, Uint8Array>()
	for (const { resource, files } of groups.values()) {
		const revision = revisionForResourceFiles(resource.kind, files)
		if (!revision) continue
		const digests: Record<string, string> = {}
		for (const path of [...files.keys()].sort(compareCodeUnits)) {
			const bytes = files.get(path)!
			const digest = blobDigest(bytes)
			digests[path] = digest
			blobs.set(digest, bytes)
		}
		resources.push({ kind: resource.kind, key: resource.key, revision, files: digests })
	}
	resources.sort((left, right) => compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.key, right.key))
	return { resources, blobs }
}

/** Every blob digest a list of version resources names. */
export function referencedDigests(resources: readonly Pick<HistoryResourceEntry, 'files'>[]): Set<string> {
	const digests = new Set<string>()
	for (const resource of resources)
		for (const digest of Object.values(resource.files)) digests.add(digest)
	return digests
}
