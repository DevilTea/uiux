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

const REPLAY_CAPTURE = `sha256:${'a'.repeat(64)}`

/**
 * A valid `interaction_replay` record (Clauses 01a17762-b293-… and 01a17762-b631-…) of one click on
 * `pay-button` of `viewId`, asserting its `click` Widget Event with the given `result`. It cites a
 * capture identity that need not be stored: the record is judged by its own shape.
 */
export function interactionReplayRecord(viewId: string, result: 'pass' | 'fail' = 'pass', capture = REPLAY_CAPTURE): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: 'interaction_replay',
		executionContext: { viewId, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
		coverage: { complete: true },
		provenance: { workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, resources: [], versions: { uiux: '0.1.0' } },
		artifactRefs: [],
		evidenceRefs: [{ kind: 'formal_capture', evidence: capture }],
		data: {
			steps: [{ action: 'click', target: { viewId, widgetId: 'pay-button' } }],
			assertions: [{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' } }, result }],
			captures: [capture],
		},
	}
}

/**
 * A valid `flow_trace` record (Clauses 01a172cc-d382-…, 01a172cc-d6f0-… and 01a172cc-daa6-…) of a Flow of one
 * step that enters `viewId`, recording the Flow at `flowRevision` and referencing `capture`.
 */
export function flowTraceRecord(flow: Readonly<{ flowId: string; flowRevision: string; stepId: string; viewId: string }>, capture: string): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: 'flow_trace',
		executionContext: { flowId: flow.flowId, locale: 'en-US', viewportId: 'desktop', themeId: 'light' },
		coverage: { complete: true },
		provenance: { workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, resources: [{ identity: { type: 'flow', id: flow.flowId }, revision: flow.flowRevision }], versions: { uiux: '0.1.0' } },
		artifactRefs: [],
		evidenceRefs: [{ kind: 'formal_capture', evidence: capture }],
		data: {
			recipe: { actions: [{ type: 'enter', stepId: flow.stepId, expect: { viewId: flow.viewId } }] },
			steps: [{ stepId: flow.stepId, viewId: flow.viewId, valid: true, captureRef: capture }],
		},
	}
}

/** Stores a record built by a helper above in a Workspace directory (a test server's), returning its identity. */
export async function putRecordInWorkspace(workspaceRoot: string, record: Record<string, unknown>): Promise<string> {
	const persistence = new FileNativePersistence({ root: workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	return (await persistence.artifacts.put(canonicalJsonBytes(record))).identity
}
