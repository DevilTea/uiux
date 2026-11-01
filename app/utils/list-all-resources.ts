import { MAX_RESOURCE_DISCOVERY_LIMIT } from '../../src/application/dto/resource-discovery'

/** One page of `listResources`: the summaries and, while more remain, the opaque cursor of the next page. */
export type ResourceListPage<T> = Readonly<{ items: readonly T[]; nextCursor?: string }>

/** The one `listResources` call the helper needs, so a test can stand in for the client. */
export type ResourceLister = Readonly<{
	listResources: <T>(
		kinds: readonly string[],
		options?: Readonly<{ limit?: number; cursor?: string; detail?: 'summary' | 'expanded' }>,
	) => Promise<ResourceListPage<T>>
}>

/** The pages a full read follows by default (`MAX_RESOURCE_DISCOVERY_LIMIT` summaries each). */
export const LIST_ALL_MAX_PAGES = 20

/**
 * Every summary of the given kinds, following `nextCursor` page by page at the server's largest page
 * size. `complete` is false when `maxPages` pages ran out while a cursor was still returned;
 * `Number.POSITIVE_INFINITY` reads until no cursor is returned. A failed
 * page read rejects, so each caller keeps its own error behavior.
 */
export async function listAllResources<T>(
	client: ResourceLister,
	kinds: readonly string[],
	options: Readonly<{ detail?: 'summary' | 'expanded'; maxPages?: number }> = {},
): Promise<Readonly<{ items: T[]; complete: boolean }>> {
	const items: T[] = []
	let cursor: string | undefined
	for (let page = 0; page < (options.maxPages ?? LIST_ALL_MAX_PAGES); page++) {
		const result: ResourceListPage<T> = await client.listResources<T>(kinds, {
			limit: MAX_RESOURCE_DISCOVERY_LIMIT,
			...(options.detail ? { detail: options.detail } : {}),
			...(cursor ? { cursor } : {}),
		})
		items.push(...result.items)
		cursor = result.nextCursor
		if (!cursor) return { items, complete: true }
	}
	return { items, complete: false }
}
