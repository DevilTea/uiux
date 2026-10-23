import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// The roster lock and the claims of its stale-lock removal are published with hard links (issue
// #325). A file system without them must be refused with a diagnostic naming the requirement, not
// waited on until `access.lock_busy`.

const refusal = vi.hoisted(() => ({ target: undefined as RegExp | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	const link: typeof actual.link = async (existing, target) => {
		if (refusal.target?.test(basename(String(target)))) throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' })
		return actual.link(existing, target)
	}
	return { ...actual, default: { ...actual, link }, link }
})

const { AccessStore, accessStorePaths, acquireLock } = await import('../src/server/access/store')

const cleanup: string[] = []

afterEach(async () => {
	refusal.target = undefined
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function rosterPaths() {
	const base = await realpath(await mkdtemp(join(tmpdir(), 'uiux-roster-links-')))
	cleanup.push(base)
	const workspace = join(base, 'ws')
	await mkdir(join(workspace, '.uiux'), { recursive: true })
	await writeFile(join(workspace, '.uiux', 'workspace.json'), '{}\n')
	const home = join(base, 'home')
	await AccessStore.open({ workspaceRoot: workspace, home, create: true })
	return accessStorePaths(home, workspace)
}

describe('roster lock on a file system without hard links', () => {
	it('refuses taking the lock as access.store_unsafe, naming the requirement', async () => {
		const paths = await rosterPaths()
		refusal.target = /^\.access\.lock$/u
		await expect(acquireLock(paths.lock, 120)).rejects.toMatchObject({ code: 'access.store_unsafe', message: expect.stringContaining('hard links') })
	})

	it('refuses removing a stale lock the same way when its claim cannot be linked', async () => {
		const paths = await rosterPaths()
		const child = spawnSync(process.execPath, ['-e', ''])
		await writeFile(paths.lock, JSON.stringify({ pid: child.pid, token: 'stale' }), { mode: 0o600 })
		refusal.target = /^\.access-lock-break-[\da-f]{32}-\d+$/u
		await expect(acquireLock(paths.lock, 120)).rejects.toMatchObject({ code: 'access.store_unsafe', message: expect.stringContaining('hard links') })
	})
})
