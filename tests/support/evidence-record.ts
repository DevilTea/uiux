import { canonicalJsonBytes, FileNativePersistence } from '../../src/persistence/file-native'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../../src/product/workspace-schema'

/**
 * Stores a minimal, valid Evidence record of the given kind (Clause 01a115cd-ce92-…) and returns
 * its identity. `seed` makes the bytes, and so the identity, unique. A kind other than
 * `formal_capture` carries no freshness check, so it suits a test of the Review submission path.
 */
export async function putEvidenceRecord(persistence: Pick<FileNativePersistence, 'artifacts'>, kind: string, seed = 'seed'): Promise<string> {
	const record = {
		schemaVersion: 1,
		kind,
		executionContext: { seed },
		coverage: { complete: true },
		provenance: { workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, resources: [], versions: { uiux: '0.1.0' } },
		artifactRefs: [],
	}
	return (await persistence.artifacts.put(canonicalJsonBytes(record))).identity
}

/** Stores an Evidence record of the given kind in an existing Workspace directory (a test server's), returning its identity. */
export async function putEvidenceRecordInWorkspace(workspaceRoot: string, kind: string, seed = 'seed'): Promise<string> {
	return putEvidenceRecord(new FileNativePersistence({ root: workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }), kind, seed)
}
