import type { FileNativePersistence } from '../persistence/file-native'
import { CheckpointStore } from '../persistence/history/checkpoint-store'
import { HostHistoryStore } from '../persistence/history/host-store'
import { assertHomeOutsideWorkspace, hostHistoryPaths, workspaceRealRoot } from './access/store'

export type HistoryStores = Readonly<{ host: HostHistoryStore; checkpoints: CheckpointStore }>

/**
 * The selected Workspace's two history stores, opened lazily once per process. `enabled` is false
 * for the internal `uiux publish` server: there `open()` resolves `undefined` and no store object
 * is ever made, so publishing cannot create, read or change host history or write a checkpoint
 * (the publication output itself carrying no history is Rule 01a11a5e-1c4e-72d9-ad72-364a6549d779).
 */
export type HistoryStoreFactory = Readonly<{
	enabled: boolean
	open(): Promise<HistoryStores | undefined>
}>

export function createHistoryStoreFactory(options: Readonly<{
	workspaceRoot: string
	persistence: FileNativePersistence
	home: () => string
	/** Set for the internal `uiux publish` server, which must never touch history. */
	publishCredential?: string
}>): HistoryStoreFactory {
	if (options.publishCredential)
		return Object.freeze({ enabled: false, open: async () => undefined })
	let pending: Promise<HistoryStores> | undefined
	return Object.freeze({
		enabled: true,
		open(): Promise<HistoryStores> {
			pending ??= (async () => {
				const realRoot = workspaceRealRoot(options.workspaceRoot)
				const home = options.home()
				assertHomeOutsideWorkspace(home, realRoot)
				const host = await HostHistoryStore.open({ paths: hostHistoryPaths(home, realRoot), create: true })
				return { host: host!, checkpoints: new CheckpointStore(options.persistence) }
			})()
			pending.catch(() => { pending = undefined })
			return pending
		},
	})
}
