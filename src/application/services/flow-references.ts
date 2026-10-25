import type { ReviewAnchorTarget } from '../../domain/reviews/anchor-state'
import { deriveWidgetTree, flattenWidgetTree } from '../../preview/widget-tree'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

/**
 * A View as a Review anchor or a Flow reference sees it: `null` when it does not exist, otherwise
 * its Variant names and Widget IDs, each left out while unknown (a View that is not valid JSON, or
 * whose Widget tree is invalid), so nothing is concluded from it.
 */
export async function readViewReferenceTarget(persistence: FileNativePersistence, viewId: string): Promise<ReviewAnchorTarget> {
	let read: Awaited<ReturnType<typeof persistence.views.readInspected>>
	try { read = await persistence.views.readInspected(viewId) }
	catch (error) {
		// An unreadable View still exists; its Widgets and Variants are unknown.
		if (error instanceof PersistenceError && error.code === 'persistence.invalid_json') return {}
		throw error
	}
	if (!read) return null
	const tree = deriveWidgetTree(read.resource.ir)
	const variants = read.resource.variants
	return {
		...(tree.status === 'valid' ? { widgetIds: new Set(flattenWidgetTree(tree.root).map(node => node.id)) } : {}),
		...(variants && typeof variants === 'object' && !Array.isArray(variants) ? { variantNames: new Set(Object.keys(variants)) } : {}),
	}
}
