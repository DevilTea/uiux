import type { FileNativePersistence } from '../persistence/file-native'
import { CheckpointStore } from '../persistence/history/checkpoint-store'
import { HostHistoryStore } from '../persistence/history/host-store'
import { assertHomeOutsideWorkspace, hostHistoryPaths, workspaceRealRoot } from './access/store'

export type HistoryStores = Readonly<{ host: HostHistoryStore; checkpoints: CheckpointStore }>

/** The selected Workspace's two history stores, opened lazily once per process. */
export type HistoryStoreFactory = Readonly<{
	open(): Promise<HistoryStores>
}>

export function createHistoryStoreFactory(options: Readonly<{
	workspaceRoot: string
	persistence: FileNativePersistence
	home: () => string
}>): HistoryStoreFactory {
	let pending: Promise<HistoryStores> | undefined
	return Object.freeze({
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
