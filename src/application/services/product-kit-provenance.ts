import { computeProductKitProvenance } from '../../adapters/kit-provenance'
import type { ProductKitProvenance } from '../../domain/product-kit/provenance'
import { isRecord, type JsonObject } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'

/**
 * The current Product Kit provenance of the Workspace (Clause 01a11bb1-8b6e-7185-b0ac-cb84c3fcc24a),
 * for formal capture, Handoff export and Evidence freshness. The Product Kit file is read under the
 * persistence read lock; the kit project is digested after it is released, so no writer waits on
 * the digest. `undefined` for a Workspace below `schemaVersion` 5 (no Product Kit file) or when the
 * file is missing or not a JSON object.
 */
export async function readWorkspaceProductKitProvenance(persistence: FileNativePersistence): Promise<ProductKitProvenance | undefined> {
	const codeDirectoryName = persistence.layout.codeDir
	if (!persistence.layout.productKitPath || !codeDirectoryName) return undefined
	const read = await persistence.productKit.readInspected().catch(() => undefined)
	if (!read || !isRecord(read.resource)) return undefined
	return computeProductKitProvenance({ root: persistence.root, codeDirectoryName, productKit: read.resource as JsonObject })
}
