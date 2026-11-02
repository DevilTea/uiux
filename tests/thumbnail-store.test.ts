import { mkdir, mkdtemp, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createThumbnailStore, thumbnailsDirectory } from '../src/server/thumbnail-store'

/** The host-local cache (Clause 01a19b99-cbd0-7076-b286-a6cee12af0f3, Rules 01a19b99-d05d-… and 01a19bb9-95ef-…). */
const VIEW = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const D1 = 'a'.repeat(64)
const D2 = 'b'.repeat(64)
const png = (value: number) => new Uint8Array([0x89, 0x50, value])

let base: string
let home: string
let workspace: string
let store: ReturnType<typeof createThumbnailStore>

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), 'uiux-thumbnails-')))
	home = join(base, 'home')
	workspace = join(base, 'workspace')
	await mkdir(home, { recursive: true, mode: 0o700 })
	await mkdir(workspace)
	store = createThumbnailStore({ workspaceRoot: workspace, home: () => home })
})
afterEach(() => rm(base, { recursive: true, force: true }))

const modeOf = async (path: string) => (await stat(path)).mode & 0o777

describe('the thumbnail cache', () => {
	it('keeps a thumbnail at $UIUX_HOME/workspaces/<wsid>/thumbnails/<viewId>/<digest>.png with modes 0700 and 0600', async () => {
		await store.write(VIEW, D1, png(1))
		const directory = thumbnailsDirectory(home, workspace)
		expect(directory.startsWith(join(home, 'workspaces') + '/')).toBe(true)
		expect(directory.endsWith('/thumbnails')).toBe(true)
		expect(await readdir(join(directory, VIEW))).toEqual([`${D1}.png`])
		expect(await modeOf(directory)).toBe(0o700)
		expect(await modeOf(join(directory, VIEW))).toBe(0o700)
		expect(await modeOf(join(directory, VIEW, `${D1}.png`))).toBe(0o600)
		expect(await store.read(VIEW, D1)).toEqual(png(1))
		expect(await store.list(VIEW)).toEqual([{ digest: D1, modifiedMs: expect.any(Number) }])
	})

	it('deletes the View\'s files of other digests once the new one is in place, so one file remains', async () => {
		await store.write(VIEW, D1, png(1))
		const directory = join(thumbnailsDirectory(home, workspace), VIEW)
		await writeFile(join(directory, '.crashed.png.tmp'), 'partial')
		const old = new Date(Date.now() - 10 * 60_000)
		await utimes(join(directory, '.crashed.png.tmp'), old, old) // a crash left it long ago
		await writeFile(join(directory, '.writing.png.tmp'), 'partial') // another server of the Workspace is writing this one now
		await store.write(VIEW, D2, png(2))
		expect((await readdir(directory)).sort()).toEqual(['.writing.png.tmp', `${D2}.png`])
		expect(await store.read(VIEW, D1)).toBeUndefined()
		expect(await store.read(VIEW, D2)).toEqual(png(2))
	})

	it('writes under a temporary name that never counts as a thumbnail (a reader sees the old file or the new, never a partial)', async () => {
		await store.write(VIEW, D1, png(1))
		const directory = join(thumbnailsDirectory(home, workspace), VIEW)
		await writeFile(join(directory, `.${D2}.png.abc.tmp`), 'partial')
		expect((await store.list(VIEW)).map(file => file.digest)).toEqual([D1])
		await store.write(VIEW, D1, png(3)) // replacing the same digest renames over it
		expect(await store.read(VIEW, D1)).toEqual(png(3))
	})

	it('removes a View\'s directory and lists the Views it holds', async () => {
		await store.write(VIEW, D1, png(1))
		await store.write(OTHER, D1, png(1))
		expect(await store.views()).toEqual([VIEW, OTHER])
		await store.remove(VIEW)
		expect(await store.views()).toEqual([OTHER])
		expect(await store.list(VIEW)).toEqual([])
		await store.remove(VIEW) // removing what is not there is fine
	})

	it('treats a missing cache as empty', async () => {
		expect(await store.views()).toEqual([])
		expect(await store.list(VIEW)).toEqual([])
		expect(await store.read(VIEW, D1)).toBeUndefined()
	})

	it('refuses a key that is not a View key and a digest that is not 64 hex digits, so no path escapes the cache', async () => {
		await expect(store.write('../escape', D1, png(1))).rejects.toThrow()
		await expect(store.list('../escape')).rejects.toThrow()
		await expect(store.write(VIEW, '../x', png(1))).rejects.toThrow()
		expect(await store.read(VIEW, '../x')).toBeUndefined()
	})

	it('refuses a UIUX_HOME inside the Workspace, which would let a thumbnail travel with a copy of it', async () => {
		const inside = createThumbnailStore({ workspaceRoot: workspace, home: () => join(workspace, '.home') })
		await expect(inside.write(VIEW, D1, png(1))).rejects.toThrow(/inside the Workspace/)
	})
})
