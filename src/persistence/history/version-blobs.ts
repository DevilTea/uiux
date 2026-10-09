import type { FileNativePersistence } from '../file-native'
import { artifactRelativePath } from '../paths'
import { blobDigest, HostHistoryError, type HostHistoryStore } from './host-store'

/**
 * Reads one blob a version names: from the host history store first, then from the Workspace's
 * artifact store, which alone keeps the blobs of member Checkpoints. The artifact copy is checked
 * against its digest. The caller holds the persistence lock (shared or exclusive).
 */
export async function readVersionBlobUnlocked(persistence: FileNativePersistence, host: HostHistoryStore | undefined, digest: string): Promise<Uint8Array | undefined> {
	const hosted = await host?.readBlob(digest)
	if (hosted) return hosted
	let path: string
	try { path = artifactRelativePath(digest) }
	catch { return undefined }
	const bytes = await persistence.readOptionalBytesUnlocked(path)
	if (!bytes) return undefined
	if (blobDigest(bytes) !== digest)
		throw new HostHistoryError('history.blob_corrupt', `Stored blob ${digest} does not match its content digest.`)
	return Uint8Array.from(bytes)
}
