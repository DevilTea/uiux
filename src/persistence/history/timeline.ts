import type { VersionRecord } from '../../domain/history/schema'
import { isFullUuid } from '../../domain/validation'
import type { FileNativePersistence } from '../file-native'
import type { CheckpointListing, CheckpointStore } from './checkpoint-store'
import type { HostHistoryStore, HostVersionListing, InvalidHistoryFile } from './host-store'
import { compareVersionOrder } from './order'

/**
 * One version of the merged timeline. `predecessor` is the version just before it in the merged
 * timeline, whichever store holds it: per the owner ruling on Discussion #122
 * (https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18820363) that merged
 * predecessor is the parent for comparison, summaries and projection, while each store's own
 * `parent` / `parentCheckpoint` pointers only keep that store's records intact.
 */
export type TimelineVersion = Readonly<{
	version: VersionRecord
	store: 'host' | 'workspace'
	predecessor?: string
}>

export type MergedTimeline = Readonly<{
	/** Every version from both stores, oldest first. */
	versions: readonly TimelineVersion[]
	/** Files in either store that are not valid records; they are left out of the timeline. */
	invalid: readonly InvalidHistoryFile[]
}>

export type TimelinePage = Readonly<{
	/** Newest first. */
	items: readonly TimelineVersion[]
	/** Present when older versions remain; pass it back as `cursor` for the next page. */
	nextCursor?: string
}>

/** A cursor that does not decode to a timeline position. */
export class TimelineCursorError extends Error {
	readonly code = 'history.invalid_cursor'
	constructor(message: string) {
		super(message)
		this.name = 'TimelineCursorError'
	}
}

/**
 * Merges host versions and checkpoints into one timeline, oldest first. Versions are listed
 * whatever schema version they were recorded under (Rules 01a11a5e-07c1-70d6-b4fb-69c99be791e3
 * and 01a11a5e-081c-7149-9345-836ce2267c0a); refusing to compare them is the caller's concern.
 */
export function mergeTimeline(host: HostVersionListing | undefined, checkpoints: CheckpointListing | undefined): MergedTimeline {
	const tagged: { version: VersionRecord; store: 'host' | 'workspace' }[] = [
		...(host?.records ?? []).map(version => ({ version, store: 'host' as const })),
		...(checkpoints?.records ?? []).map(version => ({ version, store: 'workspace' as const })),
	]
	tagged.sort((left, right) => compareVersionOrder(left.version, right.version))
	const versions = tagged.map((entry, index): TimelineVersion => {
		const previous = tagged[index - 1]
		return previous ? { ...entry, predecessor: previous.version.id } : entry
	})
	return { versions, invalid: [...(host?.invalid ?? []), ...(checkpoints?.invalid ?? [])] }
}

/**
 * Reads both stores inside one persistence read lock and merges them. Every history mutation
 * (recording, pruning, garbage collection, checkpoints) runs under the exclusive lock, so the two
 * listings are one consistent snapshot. Callers must not hold the persistence lock (nor run inside a
 * write observer hook): the read lock is taken here.
 */
export async function readMergedTimeline(persistence: FileNativePersistence, stores: Readonly<{ host?: HostHistoryStore; checkpoints?: CheckpointStore }>): Promise<MergedTimeline> {
	return persistence.withReadLock(async () => {
		const host = await stores.host?.listVersions()
		const checkpoints = await stores.checkpoints?.listUnlocked()
		return mergeTimeline(host, checkpoints)
	})
}

/**
 * One page of the timeline, newest first. The cursor names the last version a page returned by
 * its ordering key (`at`, `id`), not by an index, so it keeps its place when newer versions are
 * recorded or older ones are pruned between requests.
 */
export function pageTimeline(timeline: MergedTimeline, options: Readonly<{ limit: number; cursor?: string }>): TimelinePage {
	if (!Number.isInteger(options.limit) || options.limit < 1)
		throw new RangeError('A timeline page limit is a positive integer.')
	const after = options.cursor === undefined ? undefined : decodeTimelineCursor(options.cursor)
	const items: TimelineVersion[] = []
	let more = false
	for (let index = timeline.versions.length - 1; index >= 0; index--) {
		const entry = timeline.versions[index]!
		if (after && compareVersionOrder(entry.version, after) >= 0) continue
		if (items.length === options.limit) {
			more = true
			break
		}
		items.push(entry)
	}
	const last = items.at(-1)
	return more && last ? { items, nextCursor: encodeTimelineCursor(last.version) } : { items }
}

export function encodeTimelineCursor(position: Readonly<{ at: string; id: string }>): string {
	return Buffer.from(JSON.stringify([position.at, position.id]), 'utf8').toString('base64url')
}

export function decodeTimelineCursor(cursor: string): Readonly<{ at: string; id: string }> {
	let value: unknown
	try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) }
	catch {
		throw new TimelineCursorError('The timeline cursor is not valid.')
	}
	if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || Number.isNaN(Date.parse(value[0])) || !isFullUuid(value[1]))
		throw new TimelineCursorError('The timeline cursor is not valid.')
	return { at: value[0], id: value[1] }
}
