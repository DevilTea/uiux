import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { ThumbnailStore } from '../application/ports/thumbnails'
import { isThumbnailDigestHex } from '../domain/thumbnails/digest'
import { isFullUuid } from '../domain/validation'
import { accessStorePaths, assertHomeOutsideWorkspace, workspaceRealRoot } from './access/store'

/** The directory of a Workspace's thumbnails: `$UIUX_HOME/workspaces/<wsid>/thumbnails` (Clause 01a19b99-cbd0-7076-b286-a6cee12af0f3). */
export function thumbnailsDirectory(home: string, realRoot: string): string {
	return join(accessStorePaths(home, realRoot).dir, 'thumbnails')
}

const FILE_SUFFIX = '.png'

/**
 * The host-local thumbnail cache of one Workspace (Clause 01a19b99-cbd0-7076-b286-a6cee12af0f3):
 * `<thumbnails>/<viewId>/<digest>.png`, directories 0700 and files 0600. It sits beside the roster
 * and host history under `$UIUX_HOME`, which `uiux dev` keeps outside the Workspace, so nothing here
 * is ever committed (Rule 01a19b99-d05d-7c24-9ec7-899038e134b6). Nothing in it is canonical: deleting
 * it loses only pixels.
 */
export function createThumbnailStore(options: Readonly<{ workspaceRoot: string; home: () => string }>): ThumbnailStore {
	let root: string | undefined

	function directory(): string {
		if (root === undefined) {
			const realRoot = workspaceRealRoot(options.workspaceRoot)
			const home = options.home()
			assertHomeOutsideWorkspace(home, realRoot)
			root = thumbnailsDirectory(home, realRoot)
		}
		return root
	}

	function viewDirectory(viewId: string): string {
		if (!isFullUuid(viewId)) throw new Error('A thumbnail is kept per View key, a full UUID.')
		return join(directory(), viewId)
	}

	async function ensureDirectory(path: string): Promise<void> {
		await mkdir(path, { recursive: true, mode: 0o700 })
		await chmod(path, 0o700)
	}

	return {
		async list(viewId) {
			const dir = viewDirectory(viewId)
			let names: string[]
			try { names = await readdir(dir) }
			catch (error) {
				if (isNotFound(error)) return []
				throw error
			}
			const files: Array<{ digest: string; modifiedMs: number }> = []
			for (const name of names) {
				if (!name.endsWith(FILE_SUFFIX)) continue
				const digest = name.slice(0, -FILE_SUFFIX.length)
				if (!isThumbnailDigestHex(digest)) continue
				const stats = await lstat(join(dir, name)).catch(() => undefined)
				if (stats?.isFile()) files.push({ digest, modifiedMs: stats.mtimeMs })
			}
			return files
		},
		async read(viewId, digest) {
			if (!isThumbnailDigestHex(digest)) return undefined
			const path = join(viewDirectory(viewId), `${digest}${FILE_SUFFIX}`)
			try {
				const stats = await lstat(path)
				if (!stats.isFile()) return undefined
				return new Uint8Array(await readFile(path))
			}
			catch (error) {
				if (isNotFound(error)) return undefined
				throw error
			}
		},
		async write(viewId, digest, bytes) {
			if (!isThumbnailDigestHex(digest)) throw new Error('A thumbnail is named by the 64 hex digits of its digest.')
			const dir = viewDirectory(viewId)
			await ensureDirectory(directory())
			await ensureDirectory(dir)
			const name = `${digest}${FILE_SUFFIX}`
			// Written under a temporary name and renamed into place, so a reader never sees a partial image (Rule 01a19bb9-95ef-7a61-b7e7-0114c9327cff).
			const temporary = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`)
			try {
				await writeFile(temporary, bytes, { mode: 0o600 })
				await chmod(temporary, 0o600)
				await rename(temporary, join(dir, name))
			}
			catch (error) {
				await rm(temporary, { force: true }).catch(() => undefined)
				throw error
			}
			// Then the View's files of other digests (and any temporary file a crash left) go, so at most one file per View remains.
			for (const other of await readdir(dir)) {
				if (other !== name) await rm(join(dir, other), { force: true }).catch(() => undefined)
			}
		},
		async remove(viewId) {
			await rm(viewDirectory(viewId), { recursive: true, force: true })
		},
		async views() {
			let names: string[]
			try { names = await readdir(directory()) }
			catch (error) {
				if (isNotFound(error)) return []
				throw error
			}
			const views: string[] = []
			for (const name of names) {
				if (!isFullUuid(name)) continue
				if ((await stat(join(directory(), name)).catch(() => undefined))?.isDirectory()) views.push(name)
			}
			return views.sort()
		},
	}
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
