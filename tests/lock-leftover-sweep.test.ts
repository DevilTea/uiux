import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { currentBootId } from '../src/persistence/boot-staleness'
import {
	identityDigest,
	readJudgedLock,
	resetLockSweepThrottleForTests,
	sweepLockLeftovers,
	UNREADABLE_LEFTOVER_MS,
} from '../src/persistence/stale-lock'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { acquireLock } from '../src/server/access/store'
import { writeCurrentWorkspace } from './support/workspace-layout'

// Issue #328: the holder of a lock sweeps the candidates and claims that killed processes left,
// and never a live process's file nor a claim whose judged file could still be at the lock path.

const cleanup: string[] = []

afterEach(async () => {
	resetLockSweepThrottleForTests()
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), 'uiux-lock-sweep-')))
	cleanup.push(directory)
	return directory
}

function deadPid(): number {
	const child = spawnSync(process.execPath, ['-e', ''])
	if (child.error || typeof child.pid !== 'number') throw new Error('Could not spawn a short-lived process.', { cause: child.error })
	return child.pid
}

function record(fields: Record<string, unknown>): string {
	return JSON.stringify({ hostname: hostname(), token: randomUUID(), ...fields })
}

const DIGEST = 'a'.repeat(32)
const OTHER_DIGEST = 'b'.repeat(32)

async function setup() {
	const directory = await temporaryDirectory()
	const bootId = await currentBootId()
	const lockPath = join(directory, '.access.lock')
	await writeFile(lockPath, record({ pid: process.pid, ...(bootId ? { bootId } : {}) }))
	const sweep = { directory, lockName: '.access.lock', prefix: '.access-lock-', bootId }
	return { directory, lockPath, bootId, sweep }
}

describe('lock leftover sweep', () => {
	it('sweeps candidates and claims of a dead process and keeps those of a live one', async () => {
		const { directory, sweep, bootId } = await setup()
		const dead = record({ pid: deadPid(), ...(bootId ? { bootId } : {}) })
		const live = record({ pid: process.pid, ...(bootId ? { bootId } : {}) })
		await writeFile(join(directory, '.access-lock-dead-1.tmp'), dead)
		await writeFile(join(directory, '.access-lock-break-dead.tmp'), dead)
		await writeFile(join(directory, `.access-lock-break-${DIGEST}-0`), dead)
		await writeFile(join(directory, '.access-lock-live-1.tmp'), live)
		await writeFile(join(directory, '.access-lock-break-live.tmp'), live)
		await writeFile(join(directory, `.access-lock-break-${OTHER_DIGEST}-0`), live)
		await writeFile(join(directory, 'unrelated.tmp'), dead)

		const removed = await sweepLockLeftovers(sweep)

		expect(removed.sort()).toEqual(['.access-lock-break-dead.tmp', `.access-lock-break-${DIGEST}-0`, '.access-lock-dead-1.tmp'].sort())
		expect((await readdir(directory)).sort()).toEqual([
			'.access-lock-live-1.tmp',
			'.access-lock-break-live.tmp',
			`.access-lock-break-${OTHER_DIGEST}-0`,
			'.access.lock',
			'unrelated.tmp',
		].sort())
	})

	it('keeps a dead remover\'s claim while its judged file is at the lock path', async () => {
		const { directory, lockPath, sweep, bootId } = await setup()
		const digest = identityDigest(await readJudgedLock(lockPath))
		await writeFile(join(directory, `.access-lock-break-${digest}-0`), record({ pid: deadPid(), ...(bootId ? { bootId } : {}) }))

		expect(await sweepLockLeftovers(sweep)).toEqual([])
		expect(await readdir(directory)).toContain(`.access-lock-break-${digest}-0`)
	})

	it('keeps every claim when the file at the lock path cannot be read', async () => {
		const { directory, lockPath, sweep, bootId } = await setup()
		await rm(lockPath)
		await writeFile(join(directory, `.access-lock-break-${DIGEST}-0`), record({ pid: deadPid(), ...(bootId ? { bootId } : {}) }))

		expect(await sweepLockLeftovers(sweep)).toEqual([])
	})

	it('keeps a file of another host and sweeps one of an earlier boot', async () => {
		const { directory, sweep } = await setup()
		const bootId = '11111111-1111-4111-8111-111111111111'
		const elsewhere = JSON.stringify({ pid: deadPid(), hostname: `${hostname()}-other`, token: randomUUID() })
		await writeFile(join(directory, '.access-lock-elsewhere.tmp'), elsewhere)
		await writeFile(join(directory, '.access-lock-earlier.tmp'), record({ pid: process.pid, bootId }))

		const removed = await sweepLockLeftovers({ ...sweep, bootId: '22222222-2222-4222-8222-222222222222' })

		expect(removed).toEqual(['.access-lock-earlier.tmp'])
	})

	it('sweeps an unreadable file only once it is old', async () => {
		const { directory, sweep } = await setup()
		const fresh = join(directory, '.access-lock-fresh.tmp')
		const old = join(directory, '.access-lock-old.tmp')
		await writeFile(fresh, '')
		await writeFile(old, '{')
		const past = new Date(Date.now() - UNREADABLE_LEFTOVER_MS - 60_000)
		await utimes(old, past, past)

		expect(await sweepLockLeftovers({ ...sweep, bootId: undefined })).toEqual(['.access-lock-old.tmp'])
		expect(await readdir(directory)).toContain('.access-lock-fresh.tmp')
	})

	it('removes at most the limit per sweep', async () => {
		const { directory, sweep, bootId } = await setup()
		const dead = record({ pid: deadPid(), ...(bootId ? { bootId } : {}) })
		for (let index = 0; index < 5; index += 1) await writeFile(join(directory, `.access-lock-dead-${index}.tmp`), dead)

		expect(await sweepLockLeftovers({ ...sweep, limit: 2 })).toHaveLength(2)
		expect((await readdir(directory)).filter(name => name.endsWith('.tmp'))).toHaveLength(3)
	})

	it('is run by the roster lock holder', async () => {
		const directory = await temporaryDirectory()
		const bootId = await currentBootId()
		const leftover = join(directory, '.access-lock-dead-1.tmp')
		await writeFile(leftover, record({ pid: deadPid(), ...(bootId ? { bootId } : {}) }))

		const release = await acquireLock(join(directory, '.access.lock'))
		try { expect(await readdir(directory)).not.toContain('.access-lock-dead-1.tmp') }
		finally { await release() }
	})

	it('is run by the persistence lock holder', async () => {
		const root = await temporaryDirectory()
		await writeCurrentWorkspace(root)
		const bootId = await currentBootId()
		await writeFile(join(root, '.persistence-lock-dead-1.tmp'), record({ pid: deadPid(), ...(bootId ? { bootId } : {}) }))
		await writeFile(join(root, '.persistence-lock-live-1.tmp'), record({ pid: process.pid, ...(bootId ? { bootId } : {}) }))

		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY, lockWaitMilliseconds: 5_000 })
		await persistence.withLock(async () => {
			const names = await readdir(root)
			expect(names).not.toContain('.persistence-lock-dead-1.tmp')
			expect(names).toContain('.persistence-lock-live-1.tmp')
		})
	})
})
