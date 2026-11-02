import { shallowRef } from 'vue'
import { touchesKinds, useLiveEvents } from './useLiveEvents'
import { useUiuxClient, type ViewThumbnailStatus } from './useUiuxClient'

/**
 * View thumbnails for the Views tab (Feature 01a19b99-ca97-7aa7-b326-345c8a26caf3, served by Feature
 * 01a19b99-c9ee-7dcb-ae96-bbe31f12591c): each View's thumbnail state and whether it is being
 * refreshed, read from the server and kept current by `thumbnail.changed` events (Rule
 * 01a19b99-df3d-7654-ab9f-253a58229524). A thumbnail that cannot be captured is only a state here
 * (`missing`, or `stale` with its previous image): nothing in this module reports an error, because
 * a card shows none (Rule 01a19bac-eaeb-777f-b498-2e1c75ec706b).
 */
export type ThumbnailEntry = Readonly<{
	state: ViewThumbnailStatus['state']
	refreshing: boolean
	/** Bumped whenever the server announced a change, so the image is read again (a read is `no-store`). */
	version: number
}>

const REQUEST_CHUNK = 500
/** The writes that can make a thumbnail stale (Rule 01a19b99-d2cb-79ae-9e3d-ba6c24bc1f6a): the states are read again for them. */
const RENDERING_KINDS = ['view', 'locale', 'asset', 'workspace', 'product-kit'] as const
const MISSING: ThumbnailEntry = Object.freeze({ state: 'missing', refreshing: false, version: 0 })

export function useViewThumbnails() {
	const uiux = useUiuxClient()
	const live = useLiveEvents()
	const entries = shallowRef<ReadonlyMap<string, ThumbnailEntry>>(new Map())

	function merge(items: readonly ViewThumbnailStatus[], bump: 'all' | 'changed'): void {
		const next = new Map(entries.value)
		for (const item of items) {
			const previous = next.get(item.key)
			const changed = !previous || previous.state !== item.state
			next.set(item.key, {
				state: item.state,
				refreshing: item.refreshing,
				version: (previous?.version ?? 0) + (bump === 'all' || changed ? 1 : 0),
			})
		}
		entries.value = next
	}

	async function refresh(keys?: readonly string[], bump: 'all' | 'changed' = 'all'): Promise<void> {
		try { merge(await uiux.listViewThumbnails(keys), bump) }
		catch { /* a thumbnail is decoration: a failed read leaves what is shown */ }
	}

	/** Opening the Views tab asks the server to queue the missing and stale thumbnails of the listed Views (Rule 01a19b99-dfe8-7396-95d8-8e0cf1acf533). */
	async function request(keys: readonly string[]): Promise<void> {
		// One request names at most 1000 Views; a Workspace with more is asked for in several.
		for (let offset = 0; offset < keys.length; offset += REQUEST_CHUNK) {
			try { merge(await uiux.requestViewThumbnails(keys.slice(offset, offset + REQUEST_CHUNK)), 'changed') }
			catch { /* likewise */ }
		}
	}

	// A write that changes what a View renders leaves its image stale at once, before the server queues it: read the states, not the images.
	live.onResources((batch) => {
		if (touchesKinds(batch, RENDERING_KINDS) && !batch.resync) void refresh(undefined, 'changed')
	})
	// `thumbnail.changed` names the View; a resync (a reconnect or the first `hello`) reads every View again.
	live.onThumbnails((batch) => {
		if (batch.resync) void refresh(undefined, 'changed')
		else if (batch.keys.length > 0) void refresh(batch.keys)
	})

	return {
		entryOf: (key: string): ThumbnailEntry => entries.value.get(key) ?? MISSING,
		/** The URL of the View's image, or `undefined` while it has none (the placeholder shows then). */
		imageUrl(key: string): string | undefined {
			const entry = entries.value.get(key)
			return entry && entry.state !== 'missing' ? uiux.viewThumbnailUrl(key, entry.version) : undefined
		},
		load: () => refresh(undefined, 'changed'),
		request,
	}
}
