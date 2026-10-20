import type { FileNativePersistence } from '../file-native'
import { blobDigest, HostHistoryError, type HostHistoryStore } from './host-store'

/**
 * Reads one blob a version names: from the host history store first, then from the Workspace's
 * artifact store, which alone keeps the blobs of member Checkpoints. The artifact copy is checked
 * against its digest. The caller holds the persistence lock (shared or exclusive).
 */
export async function readVersionBlobUnlocked(persistence: FileNativePersistence, host: HostHistoryStore | undefined, digest: string): Promise<Uint8Array | undefined> {
	const hosted = await host?.readBlob(digest)
	if (hosted) return hosted
	return readArtifactBlobUnlocked(persistence, digest)
}

/**
 * Reads one blob from the Workspace's artifact store, checked against its digest; `undefined` when
 * the store does not have it (or the digest is not a store identity). The caller holds the
 * persistence lock (shared or exclusive).
 */
export async function readArtifactBlobUnlocked(persistence: FileNativePersistence, digest: string): Promise<Uint8Array | undefined> {
	let path: string
	try { path = persistence.layout.artifactRelativePath(digest) }
	catch { return undefined }
	const bytes = await persistence.readOptionalBytesUnlocked(path)
	if (!bytes) return undefined
	if (blobDigest(bytes) !== digest)
		throw new HostHistoryError('history.blob_corrupt', `Stored blob ${digest} does not match its content digest.`)
	return Uint8Array.from(bytes)
}

export type HostBlobCopy = Readonly<{
	/** Digests copied into host history. */
	copied: readonly string[]
	/** Digests host history lacks that neither `known` nor the artifact store could supply, with why. */
	missing: readonly Readonly<{ digest: string; reason: string }>[]
}>

/**
 * Clause 01a11a5e-1e65-7deb-a89e-6ad021248fe0 (issue #253): host history keeps every blob its
 * versions name, so a host version never depends on the artifact store, where a Checkpoint's blobs
 * live and where artifact cleanup on another host, which cannot see this host's history, may remove
 * them. Copies into the host store each of `digests` it lacks, taking the bytes from `known` (the
 * bytes the caller already holds) or else from the artifact store; a blob already there is never
 * copied again. A blob that cannot be supplied (absent, unreadable, or a corrupt artifact copy) is reported in
 * `missing` rather than thrown, so a store that was already incomplete never stops recording. The
 * caller holds the persistence lock (shared or exclusive).
 */
export async function copyVersionBlobsToHostUnlocked(
	persistence: FileNativePersistence,
	host: HostHistoryStore,
	digests: Iterable<string>,
	known?: ReadonlyMap<string, Uint8Array>,
): Promise<HostBlobCopy> {
	const copied: string[] = []
	const missing: { digest: string; reason: string }[] = []
	for (const digest of new Set(digests)) {
		if (await host.hasBlob(digest)) continue
		let bytes: Uint8Array | undefined
		try {
			bytes = known?.get(digest) ?? await readArtifactBlobUnlocked(persistence, digest)
		}
		catch (error) {
			missing.push({ digest, reason: error instanceof Error ? error.message : String(error) })
			continue
		}
		if (!bytes || blobDigest(bytes) !== digest) {
			missing.push({ digest, reason: 'neither host history nor the artifact store has it' })
			continue
		}
		await host.putBlob(bytes)
		copied.push(digest)
	}
	return { copied, missing }
}
