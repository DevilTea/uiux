import { canonicalJsonBytes, FileNativePersistence } from '../../src/persistence/file-native'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../../src/product/workspace-schema'
import { readCurrentAdapterProvenance } from '../../src/application/services/adapter-provenance'
import { readWorkspaceProductKitProvenance } from '../../src/application/services/product-kit-provenance'
import type { EvidenceAdapterProvenance } from '../../src/domain/evidence/adapter-provenance'
import type { ProductKitProvenance } from '../../src/domain/product-kit/provenance'

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

/**
 * The Workspace's current Adapter and Product Kit provenance as formal capture records it (Clauses
 * 01a1161c-008a-… and 01a11bb1-8fc4-…), to spread into a fixture record's `provenance`: a capture
 * without either has unknown freshness (Rule 01a1161b-ff68-…).
 */
export async function currentCaptureProvenance(persistence: FileNativePersistence): Promise<Readonly<{ adapters?: readonly EvidenceAdapterProvenance[]; productKit?: ProductKitProvenance }>> {
	const adapters = await readCurrentAdapterProvenance(persistence)
	const productKit = await readWorkspaceProductKitProvenance(persistence)
	return { ...(adapters.state === 'available' ? { adapters: adapters.adapters } : {}), ...(productKit ? { productKit } : {}) }
}

/** Stores an Evidence record of the given kind in an existing Workspace directory (a test server's), returning its identity. */
export async function putEvidenceRecordInWorkspace(workspaceRoot: string, kind: string, seed = 'seed'): Promise<string> {
	return putEvidenceRecord(new FileNativePersistence({ root: workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }), kind, seed)
}
