import type { FormalEvidenceRecord } from '../../domain/evidence/schema'
import { resourceIdentityKey } from '../../domain/history/summary'
import type { ImpactEvidence, ImpactWorkspace } from '../../domain/impact'
import type { FileNativePersistence } from '../../persistence/file-native'
import { versionResourcesFromSnapshot } from '../../persistence/history/snapshot'
import { REVIEW_FILE_SUFFIX, WORKSPACE_DATA_DIRECTORY, type WorkspaceLayout } from '../../persistence/paths'
import { canonicalJsonBytes, revisionForResourceFiles } from '../../persistence/file-native'
import { formalCaptureRecordOf } from './formal-capture'

/**
 * The picture of the current Workspace that reference-impact analysis compares (`src/domain/impact`),
 * shared by the single-resource restore and by the authoring operations that delete or change the
 * identity of a resource (issue #75). It is read under one shared persistence lock, decoded
 * leniently: whatever cannot be read is left out, never thrown over.
 */

/** Decodes UTF-8 JSON, or `undefined` when the bytes are not valid. */
export function parseJsonBytes(bytes: Uint8Array): unknown {
	try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
	catch { return undefined }
}

/** The analysis picture of a snapshot of the versioned files, the Reviews and, when asked, the formal Evidence. */
export function impactWorkspaceFromSnapshot(snapshot: ReadonlyMap<string, Uint8Array>, layout: WorkspaceLayout, reviews: readonly unknown[], evidence: readonly ImpactEvidence[] | undefined): ImpactWorkspace {
	const revisions = new Map<string, string>()
	for (const resource of versionResourcesFromSnapshot(snapshot, layout).resources) revisions.set(resourceIdentityKey(resource), resource.revision)
	const views = new Map<string, unknown>()
	const flows = new Map<string, unknown>()
	const locales = new Map<string, unknown>()
	const assets = new Set<string>()
	let manifest: unknown
	for (const [path, bytes] of snapshot) {
		const identity = layout.classifyVersionedPath(path)
		if (!identity) continue
		if (identity.kind === 'asset') {
			if (revisions.has(resourceIdentityKey(identity))) assets.add(identity.key)
			continue
		}
		const value = parseJsonBytes(bytes)
		if (value === undefined) continue
		if (identity.kind === 'workspace') manifest = value
		else if (identity.kind === 'view') views.set(identity.key, value)
		else if (identity.kind === 'flow') flows.set(identity.key, value)
		else if (identity.kind === 'locale') locales.set(identity.key, value)
	}
	return { manifest, views, flows, locales, assets, reviews, revisions, ...(evidence ? { evidence } : {}) }
}

/** Every Review thread file, decoded leniently: the analysis only follows what it can read. Needs a persistence lock. */
export async function readImpactReviewsUnlocked(persistence: FileNativePersistence): Promise<readonly unknown[]> {
	const entries = await persistence.listDirectoryUnlocked(WORKSPACE_DATA_DIRECTORY.reviews)
	const reviews: unknown[] = []
	for (const entry of entries ?? []) {
		if (!entry.isFile() || !entry.name.endsWith(REVIEW_FILE_SUFFIX)) continue
		const bytes = await persistence.readOptionalBytesUnlocked(`${WORKSPACE_DATA_DIRECTORY.reviews}/${entry.name}`)
		const value = bytes ? parseJsonBytes(bytes) : undefined
		if (value !== undefined) reviews.push(value)
	}
	return reviews
}

/** The formal Evidence records, read as `listEvidence` reads them (all artifacts under one shared lock). */
export async function readImpactEvidence(persistence: FileNativePersistence): Promise<readonly ImpactEvidence[]> {
	const evidence: ImpactEvidence[] = []
	for (const { identity: digest, value: record } of await persistence.artifacts.readAllCandidateJson<unknown, FormalEvidenceRecord>({ tolerateErrors: true, select: formalCaptureRecordOf })) {
		evidence.push({ digest, record })
	}
	return evidence
}

/** The current Workspace as the analysis sees it, read under one shared lock; `evidence` also reads the formal Evidence. */
export async function readImpactWorkspace(persistence: FileNativePersistence, options: Readonly<{ evidence?: boolean }> = {}): Promise<ImpactWorkspace> {
	const { snapshot, reviews } = await persistence.withReadLock(async () => ({
		snapshot: await persistence.scanVersionedSnapshotUnlocked(),
		reviews: await readImpactReviewsUnlocked(persistence),
	}))
	const evidence = options.evidence ? await readImpactEvidence(persistence) : undefined
	return impactWorkspaceFromSnapshot(snapshot, persistence.layout, reviews, evidence)
}

/**
 * The current Workspace as the analysis sees it, read while the caller already holds the persistence
 * lock (a delete guard re-checks the impact inside the exclusive lock, so a reference added since the
 * first look is never missed). It reads no Evidence.
 */
export async function readImpactWorkspaceUnlocked(persistence: FileNativePersistence): Promise<ImpactWorkspace> {
	return impactWorkspaceFromSnapshot(await persistence.scanVersionedSnapshotUnlocked(), persistence.layout, await readImpactReviewsUnlocked(persistence), undefined)
}

/** The revision a single-file resource (a View, a Flow or the Workspace settings) has once `next` is written. */
export function nextSingleFileRevision(kind: 'view' | 'flow' | 'workspace', next: unknown): string | undefined {
	return revisionForResourceFiles(kind, new Map([[kind, canonicalJsonBytes(next)]]))
}
