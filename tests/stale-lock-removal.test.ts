import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { link, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { FileNativePersistence } from '../src/persistence'
import { setStaleLockHookForTests } from '../src/persistence/stale-lock'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { AccessStore, accessStorePaths, acquireLock } from '../src/server/access/store'
import { writeCurrentWorkspace } from './support/workspace-layout'

// Issue #325: two processes that judge the same lock stale must not let the slower one delete the
// lock the faster one took after removing the stale file. Each test pauses one remover between its
// judgment and its removal, the window in which a removal by path deleted the newer lock.

const cleanup: string[] = []

afterEach(async () => {
	setStaleLockHookForTests()
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	cleanup.push(directory)
	return directory
}

/** The pid of a process that has exited, as a crashed lock holder leaves it behind. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ['-e', ''])
	if (child.error || typeof child.pid !== 'number') throw new Error('Could not spawn a short-lived process.', { cause: child.error })
	return child.pid
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void
	const promise = new Promise<T>(settle => { resolve = settle })
	return { promise, resolve }
}

type Stage = 'judged' | 'claimed' | 'settled'

/**
 * Pauses the first remover at `pauseAt` until `resume` is called; `settled[n]` resolves when the
 * n-th removal attempt (in the order they settle) ends.
 */
function pauseFirstRemover(pauseAt: Stage) {
	const paused = deferred()
	const gate = deferred()
	const settled = [deferred(), deferred(), deferred()]
	let seen = 0
	let settledCount = 0
	setStaleLockHookForTests(async (stage) => {
		if (stage === 'settled') {
			settled[settledCount]?.resolve()
			settledCount += 1
			return
		}
		if (stage !== pauseAt) return
		seen += 1
		if (seen !== 1) return
		paused.resolve()
		await gate.promise
	})
	return { paused: paused.promise, resume: () => gate.resolve(), settled: settled.map(entry => entry.promise) }
}

async function persistenceRoot(): Promise<string> {
	const root = await temporaryDirectory('uiux-stale-lock-')
	await writeCurrentWorkspace(root)
	return root
}

function openPersistence(root: string): FileNativePersistence {
	return new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY, lockWaitMilliseconds: 5_000 })
}

async function plantDeadPersistenceLock(root: string): Promise<string> {
	const lockPath = join(root, '.persistence.lock')
	await writeFile(lockPath, JSON.stringify({ pid: deadPid(), token: randomUUID() }))
	return lockPath
}

async function persistenceLockFiles(root: string): Promise<string[]> {
	return (await readdir(root)).filter(name => name === '.persistence.lock' || name.startsWith('.persistence-lock-'))
}

describe('persistence lock: stale-lock removal race (issue #325)', () => {
	it('keeps the lock that the faster remover took when the slower remover resumes', async () => {
		const root = await persistenceRoot()
		const lockPath = await plantDeadPersistenceLock(root)
		const race = pauseFirstRemover('judged')
		const slower = openPersistence(root).withLock(async () => 'slower')
		await race.paused
		const faster = await openPersistence(root).withLock(async () => {
			const held = await readFile(lockPath, 'utf8')
			race.resume()
			// The faster remover's attempt settled first; this is the slower one's.
			await race.settled[1]
			expect(await readFile(lockPath, 'utf8')).toBe(held)
			return 'faster'
		})
		expect(faster).toBe('faster')
		expect(await slower).toBe('slower')
		expect(await persistenceLockFiles(root)).toEqual([])
	})

	it('lets one remover at a time remove a stale lock: another waits while the claim\'s owner runs', async () => {
		const root = await persistenceRoot()
		const lockPath = await plantDeadPersistenceLock(root)
		const stale = await readFile(lockPath, 'utf8')
		const race = pauseFirstRemover('claimed')
		const first = openPersistence(root).withLock(async () => 'first')
		await race.paused
		const waiting = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY, lockWaitMilliseconds: 120 })
		await expect(waiting.withLock(async () => 'second')).rejects.toMatchObject({ code: 'persistence.lock_busy' })
		expect(await readFile(lockPath, 'utf8')).toBe(stale)
		race.resume()
		expect(await first).toBe('first')
		expect(await persistenceLockFiles(root)).toEqual([])
	})

	it('passes over the claim of a remover that died mid-removal and clears its claims', async () => {
		const root = await persistenceRoot()
		await plantDeadPersistenceLock(root)
		const race = pauseFirstRemover('claimed')
		const first = openPersistence(root).withLock(async () => 'first')
		await race.paused
		// Make the paused remover's claim look like one a killed process left behind.
		const claims = (await readdir(root)).filter(name => /^\.persistence-lock-break-[\da-f]{32}-0$/u.test(name))
		expect(claims).toHaveLength(1)
		await writeFile(join(root, claims[0]!), JSON.stringify({ pid: deadPid(), token: randomUUID() }))
		expect(await openPersistence(root).withLock(async () => 'second')).toBe('second')
		race.resume()
		expect(await first).toBe('first')
		expect(await persistenceLockFiles(root)).toEqual([])
	})

	it('has no cap on the claims of dead removers: a lock with many of them is still removed', async () => {
		const root = await persistenceRoot()
		await plantDeadPersistenceLock(root)
		const race = pauseFirstRemover('claimed')
		const first = openPersistence(root).withLock(async () => 'first')
		await race.paused
		const [claim] = (await readdir(root)).filter(name => /^\.persistence-lock-break-[\da-f]{32}-0$/u.test(name))
		const dead = JSON.stringify({ pid: deadPid(), token: randomUUID() })
		for (let level = 0; level < 12; level += 1) await writeFile(join(root, claim!.replace(/-0$/u, `-${level}`)), dead)
		expect(await openPersistence(root).withLock(async () => 'second')).toBe('second')
		race.resume()
		expect(await first).toBe('first')
		expect(await persistenceLockFiles(root)).toEqual([])
	})

	it('still ends at the wait budget when every removal finds the lock replaced by another stale one', async () => {
		const root = await persistenceRoot()
		const lockPath = await plantDeadPersistenceLock(root)
		setStaleLockHookForTests(async (stage) => {
			if (stage === 'claimed') {
				await rm(lockPath)
				await writeFile(lockPath, JSON.stringify({ pid: deadPid(), token: randomUUID() }))
			}
		})
		const waiting = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY, lockWaitMilliseconds: 120 })
		await expect(waiting.withLock(async () => undefined)).rejects.toMatchObject({ code: 'persistence.lock_busy' })
	})
})

describe('roster lock: stale-lock removal race (issue #325)', () => {
	async function rosterLock() {
		const base = await temporaryDirectory('uiux-stale-roster-')
		const workspace = join(base, 'ws')
		await mkdir(join(workspace, '.uiux'), { recursive: true })
		await writeFile(join(workspace, '.uiux', 'workspace.json'), '{}\n')
		const home = join(base, 'home')
		await AccessStore.open({ workspaceRoot: workspace, home, create: true })
		const paths = accessStorePaths(home, workspace)
		await writeFile(paths.lock, JSON.stringify({ pid: deadPid(), token: 'stale' }), { mode: 0o600 })
		const lockFiles = async () => (await readdir(paths.dir)).filter(name => name === '.access.lock' || name.startsWith('.access-lock-'))
		return { paths, lockFiles }
	}

	it('keeps the lock that the faster remover took when the slower remover resumes', async () => {
		const { paths, lockFiles } = await rosterLock()
		const race = pauseFirstRemover('judged')
		const slower = acquireLock(paths.lock, 5_000)
		await race.paused
		const releaseFaster = await acquireLock(paths.lock, 5_000)
		const held = await readFile(paths.lock, 'utf8')
		race.resume()
		await race.settled[1]
		expect(await readFile(paths.lock, 'utf8')).toBe(held)
		await releaseFaster()
		const releaseSlower = await slower
		expect(JSON.parse(await readFile(paths.lock, 'utf8'))).toMatchObject({ pid: process.pid })
		await releaseSlower()
		expect(await lockFiles()).toEqual([])
	})

	it('lets one remover at a time remove a stale lock: another waits while the claim\'s owner runs', async () => {
		const { paths, lockFiles } = await rosterLock()
		const stale = await readFile(paths.lock, 'utf8')
		const race = pauseFirstRemover('claimed')
		const first = acquireLock(paths.lock, 5_000)
		await race.paused
		await expect(acquireLock(paths.lock, 120)).rejects.toMatchObject({ code: 'access.lock_busy' })
		expect(await readFile(paths.lock, 'utf8')).toBe(stale)
		race.resume()
		await (await first)()
		expect(await lockFiles()).toEqual([])
	})

	it('still ends at the wait budget when every removal finds the lock replaced by another stale one', async () => {
		const { paths } = await rosterLock()
		setStaleLockHookForTests(async (stage) => {
			if (stage === 'claimed') {
				await rm(paths.lock)
				await writeFile(paths.lock, JSON.stringify({ pid: deadPid(), token: 'stale' }), { mode: 0o600 })
			}
		})
		await expect(acquireLock(paths.lock, 120)).rejects.toMatchObject({ code: 'access.lock_busy' })
	})
})

describe('roster lock publication (issue #325 review)', () => {
	async function rosterDirectory() {
		const base = await temporaryDirectory('uiux-roster-publish-')
		const workspace = join(base, 'ws')
		await mkdir(join(workspace, '.uiux'), { recursive: true })
		await writeFile(join(workspace, '.uiux', 'workspace.json'), '{}\n')
		const home = join(base, 'home')
		await AccessStore.open({ workspaceRoot: workspace, home, create: true })
		return accessStorePaths(home, workspace)
	}

	it('publishes the lock complete, so a holder killed before writing its record leaves no lock', async () => {
		const paths = await rosterDirectory()
		// What a process killed between creating its candidate and writing the record leaves on disk.
		const leftover = join(paths.dir, `.access-lock-${randomUUID().replace(/-/gu, '').slice(0, 16)}-0123456789ab.tmp`)
		await writeFile(leftover, '', { mode: 0o600 })
		const release = await acquireLock(paths.lock, 120)
		expect(JSON.parse(await readFile(paths.lock, 'utf8'))).toMatchObject({ pid: process.pid, token: expect.any(String) })
		await release()
		expect(await readFile(paths.lock).catch(error => error.code)).toBe('ENOENT')
	})

	it('clears the lock of a holder killed between publishing it and removing its candidate', async () => {
		const paths = await rosterDirectory()
		const candidate = join(paths.dir, '.access-lock-0123456789abcdef-0123456789ab.tmp')
		await writeFile(candidate, JSON.stringify({ pid: deadPid(), token: '0123456789abcdef' }), { mode: 0o600 })
		await link(candidate, paths.lock)
		const release = await acquireLock(paths.lock, 500)
		expect(JSON.parse(await readFile(paths.lock, 'utf8'))).toMatchObject({ pid: process.pid })
		await release()
	})
})
