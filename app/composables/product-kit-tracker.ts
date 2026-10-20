import type { LiveBatch } from './useLiveEvents'

/**
 * Tracks the Product Kit file's revision the open Preview was last known to render from (Discussion
 * #241 owner decision 2, https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19070362).
 * A `product-kit` event names the new revision; a resync names nothing, so the file is read again.
 * The baseline is recorded when a View's Preview starts, so a change between selecting the View and
 * the first event or resync counts as a change.
 */
export type ProductKitTracker = Readonly<{
	/** Forgets the revision and reads the current one as the baseline of a Preview that is starting. */
	startPreview: () => Promise<void>
	/** Whether the file moved since the baseline, given a batch of change events. */
	moved: (batch: LiveBatch) => Promise<boolean>
}>

export function createProductKitTracker(readRevision: () => Promise<string | undefined>): ProductKitTracker {
	let revision: string | undefined
	/** Starts of a Preview; a later start supersedes the baseline read of an earlier one. */
	let generation = 0

	async function startPreview(): Promise<void> {
		const mine = ++generation
		revision = undefined
		let read: string | undefined
		try { read = await readRevision() }
		catch { return }
		// An event or resync that arrived meanwhile has set a newer baseline already.
		if (mine === generation && revision === undefined) revision = read
	}

	async function moved(batch: LiveBatch): Promise<boolean> {
		const named = batch.changes.find(change => change.kind === 'product-kit')
		if (!batch.resync && !named) return false
		const mine = generation
		let next = named?.revision
		if (next === undefined) {
			try { next = await readRevision() }
			catch { return false }
			// A Preview started meanwhile; this read belongs to the superseded one.
			if (mine !== generation) return false
		}
		const known = revision
		revision = next
		// Without a baseline yet, only an event that named a change counts.
		return known === undefined ? named !== undefined : known !== next
	}

	return { startPreview, moved }
}
