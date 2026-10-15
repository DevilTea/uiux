import { computeProductKitProvenance } from '../../adapters/kit-provenance'
import type { CurrentProductKitProvenance, ProductKitProvenance } from '../../domain/product-kit/provenance'
import { isRecord, type JsonObject } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'

/**
 * The current Product Kit provenance of the Workspace (Clause 01a11bb1-8b6e-7185-b0ac-cb84c3fcc24a),
 * for formal capture, Handoff export and Evidence freshness. The Product Kit file is read under the
 * persistence read lock; the kit project is digested after it is released (through the shared
 * digest cache), so no writer waits on the digest. `none` for a Workspace below `schemaVersion` 5,
 * which has no Product Kit file; `unavailable` when it has one but the file cannot be read or is not
 * a JSON object, or the kit cannot be digested.
 */
export async function readCurrentProductKitProvenance(persistence: FileNativePersistence): Promise<CurrentProductKitProvenance> {
	const codeDirectoryName = persistence.layout.codeDir
	if (!persistence.layout.productKitPath || !codeDirectoryName) return { state: 'none' }
	const read = await persistence.productKit.readInspected().catch(() => undefined)
	if (!read || !isRecord(read.resource)) return { state: 'unavailable' }
	const provenance = await computeProductKitProvenance({ root: persistence.root, codeDirectoryName, productKit: read.resource as JsonObject }).catch(() => undefined)
	return provenance ? { state: 'available', provenance } : { state: 'unavailable' }
}

/** The current Product Kit provenance when it is available ({@link readCurrentProductKitProvenance}), else `undefined`. */
export async function readWorkspaceProductKitProvenance(persistence: FileNativePersistence): Promise<ProductKitProvenance | undefined> {
	const current = await readCurrentProductKitProvenance(persistence)
	return current.state === 'available' ? current.provenance : undefined
}
