import type { ResolvedRenderContext } from '../../domain/render-context/schema'

/**
 * View thumbnails as the application layer sees them (Feature 01a19b99-c9ee-7dcb-ae96-bbe31f12591c,
 * values in Contract 01a19b99-cb2f-76fb-add5-2ede8d0aebdd): the server's thumbnail service
 * (`src/application/services/thumbnails.ts`) implements the operations, and the host-local cache
 * (`src/server/thumbnail-store.ts`) implements the store.
 */

/** Clause 01a19b99-cd8b-7a8d-a357-5a55fa9453d7. */
export type ThumbnailState = 'fresh' | 'stale' | 'missing'

/** One View's thumbnail state and whether it is being refreshed (Rule 01a19b99-d985-7c77-9420-1c5a19db7c69). */
export type ThumbnailStatus = Readonly<{ key: string; state: ThumbnailState; refreshing: boolean }>

/** The three operations of Clause 01a19bb9-8f1f-7482-b6fd-f131a284178e, each needing `workspace.read`. */
export interface ThumbnailOperations {
	/** The View's stored PNG, its fresh one else its stale one (Rule 01a19b99-d8d5-742c-97aa-1b8701b909f7), or `undefined` while it is missing; it never captures. */
	read(viewId: string): Promise<Uint8Array | undefined>
	/** The state of each named View's thumbnail (every View when none is named); a name that is no View is left out. */
	list(viewIds?: readonly string[]): Promise<readonly ThumbnailStatus[]>
	/** Queues the missing and stale thumbnails of the named Views at once, then lists them as `list` does. */
	request(viewIds: readonly string[]): Promise<readonly ThumbnailStatus[]>
}

/** The host-local cache of Clause 01a19b99-cbd0-7076-b286-a6cee12af0f3. */
export interface ThumbnailStore {
	/** The View's stored files, each by its digest (64 hex digits) and modification time; a temporary file is not one. */
	list(viewId: string): Promise<readonly Readonly<{ digest: string; modifiedMs: number }>[]>
	read(viewId: string, digest: string): Promise<Uint8Array | undefined>
	/** Writes under a temporary name, renames it into place, then deletes the View's files of other digests (Rule 01a19bb9-95ef-7a61-b7e7-0114c9327cff). */
	write(viewId: string, digest: string, bytes: Uint8Array): Promise<void>
	/** Deletes every file of the View (Rule 01a19b99-d814-7fdf-8742-5f7fad22684a). */
	remove(viewId: string): Promise<void>
	/** The Views that have a directory in the cache. */
	views(): Promise<readonly string[]>
}

/** What the worker needs to capture one View: its default context and the digest the file is named by. */
export type ThumbnailPlan = Readonly<{
	key: string
	/** The thumbnail input digest, `undefined` while it cannot be computed (Clause 01a19b99-cd8b-7a8d-a357-5a55fa9453d7). */
	digest?: string
	context?: ResolvedRenderContext
}>

/** The inputs of every thumbnail, read from the Workspace. */
export interface ThumbnailInputsSource {
	/** The plan of each named existing View, or of every readable View when none is named. */
	plans(viewIds?: readonly string[]): Promise<readonly ThumbnailPlan[]>
	/** Whether the default Locale has no Locale file (Rule 01a19b99-d5e3-7c51-a1f5-2ea86f20f9f6). */
	defaultLocaleMissing(): Promise<boolean>
}

export type ThumbnailCaptureOutcome =
	| Readonly<{ ok: true; png: Uint8Array }>
	| Readonly<{ ok: false; reason: string }>

/** Captures one thumbnail image; it launches its browser on the first capture, `close()` ends it (the next capture launches again) and `close(true)` ends it for good: no capture launches a browser after it. */
export interface ThumbnailCapturer {
	capture(job: Readonly<{ key: string; context: ResolvedRenderContext }>): Promise<ThumbnailCaptureOutcome>
	close(final?: boolean): Promise<void>
}
