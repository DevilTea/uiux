import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { acquireServerHold, readActiveServerHold } from '../src/persistence'
import { BOOT_STALENESS_TOLERANCE_MS, currentBootId, currentBootTimeMs, isFromEarlierBoot, predatesCurrentBoot } from '../src/persistence/boot-staleness'
import { AccessStore, accessStorePaths } from '../src/server/access/store'
import { CURRENT_TEST_LAYOUT } from './support/workspace-layout'

// Owner ruling 2026-10-23 (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19145490):
// a host lock or hold file from an earlier boot is stale whatever it records. A recorded boot
// session identifier decides; only a record without one falls back to the modification time.

const BOOT_ID = await currentBootId()

const cleanup: string[] = []

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	cleanup.push(directory)
	return directory
}

async function setWrittenBeforeBoot(path: string): Promise<void> {
	const beforeBoot = new Date(currentBootTimeMs() - 60_000)
	await utimes(path, beforeBoot, beforeBoot)
}

describe('predatesCurrentBoot', () => {
	const boot = 1_800_000_000_000

	it('calls a file stale only when it was written before boot by more than the tolerance', () => {
		expect(predatesCurrentBoot({ mtimeMs: boot - BOOT_STALENESS_TOLERANCE_MS - 1 }, boot)).toBe(true)
		expect(predatesCurrentBoot({ mtimeMs: boot - 86_400_000 }, boot)).toBe(true)
		expect(predatesCurrentBoot({ mtimeMs: boot - BOOT_STALENESS_TOLERANCE_MS }, boot)).toBe(false)
		expect(predatesCurrentBoot({ mtimeMs: boot - 1_000 }, boot)).toBe(false)
		expect(predatesCurrentBoot({ mtimeMs: boot }, boot)).toBe(false)
		expect(predatesCurrentBoot({ mtimeMs: boot + 1 }, boot)).toBe(false)
	})

	it('never calls a file written now stale', () => {
		expect(predatesCurrentBoot({ mtimeMs: Date.now() })).toBe(false)
		expect(currentBootTimeMs()).toBeLessThanOrEqual(Date.now())
	})
})

describe('isFromEarlierBoot', () => {
	const boot = 1_800_000_000_000
	const current = '7e8ccf7b-4c7e-4216-b79f-38117883d218'
	const beforeBoot = { mtimeMs: boot - 60_000 }
	const sinceBoot = { mtimeMs: boot + 60_000 }

	it('decides by the recorded boot identifier, whatever the modification time says', () => {
		expect(isFromEarlierBoot({ bootId: current }, beforeBoot, current, boot)).toBe(false)
		expect(isFromEarlierBoot({ bootId: current.toUpperCase() }, beforeBoot, current, boot)).toBe(false)
		expect(isFromEarlierBoot({ bootId: randomUUID() }, sinceBoot, current, boot)).toBe(true)
	})

	it('falls back to the modification time without a usable recorded or current identifier', () => {
		for (const record of [undefined, null, 5, {}, { bootId: 7 }, { bootId: 'not-a-boot-id' }]) {
			expect(isFromEarlierBoot(record, beforeBoot, current, boot)).toBe(true)
			expect(isFromEarlierBoot(record, sinceBoot, current, boot)).toBe(false)
		}
		expect(isFromEarlierBoot({ bootId: randomUUID() }, sinceBoot, undefined, boot)).toBe(false)
		expect(isFromEarlierBoot({ bootId: randomUUID() }, beforeBoot, undefined, boot)).toBe(true)
	})

	it.skipIf(!['linux', 'darwin'].includes(process.platform))('reads the boot identifier of this host once, as a lowercase UUID', async () => {
		expect(BOOT_ID).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u)
		expect(await currentBootId()).toBe(BOOT_ID)
	})
})

describe('roster lock staleness by boot', () => {
	async function rosterWithLeftover() {
		const base = await temporaryDirectory('uiux-boot-roster-')
		const workspace = join(base, 'ws')
		await mkdir(join(workspace, '.uiux'), { recursive: true })
		await writeFile(join(workspace, '.uiux', 'workspace.json'), '{}\n')
		const home = join(base, 'home')
		const paths = accessStorePaths(home, workspace)
		await AccessStore.open({ workspaceRoot: workspace, home, create: true })
		// Opening removes this leftover only when it can take the roster lock without waiting.
		const leftover = 'access.json.0123456789ab.tmp'
		await writeFile(join(paths.dir, leftover), 'x', { mode: 0o600 })
		return { workspace, home, paths, leftover }
	}

	it.each([
		['the pid of this live process', () => JSON.stringify({ pid: process.pid, token: 'held' })],
		['pid 1, which answers EPERM or is alive', () => JSON.stringify({ pid: 1, token: 'held' })],
		['no bytes at all', () => ''],
	])('clears a roster lock without a boot identifier written before the current boot that records %s', async (_label, record) => {
		const { workspace, home, paths, leftover } = await rosterWithLeftover()
		await writeFile(paths.lock, record(), { mode: 0o600 })
		await setWrittenBeforeBoot(paths.lock)
		await AccessStore.open({ workspaceRoot: workspace, home })
		const names = await readdir(paths.dir)
		expect(names).not.toContain(leftover)
		expect(await readFile(paths.lock).catch(error => error.code)).toBe('ENOENT')
	})

	it('clears a roster lock that records another boot, even with a live pid and a fresh time', async () => {
		const { workspace, home, paths, leftover } = await rosterWithLeftover()
		await writeFile(paths.lock, JSON.stringify({ pid: process.pid, token: 'held', bootId: randomUUID() }), { mode: 0o600 })
		await AccessStore.open({ workspaceRoot: workspace, home })
		expect(await readdir(paths.dir)).not.toContain(leftover)
		expect(await readFile(paths.lock).catch(error => error.code)).toBe('ENOENT')
	})

	it.skipIf(BOOT_ID === undefined)('keeps a live roster lock that records the current boot although its time lies before boot (a clock step)', async () => {
		const { workspace, home, paths, leftover } = await rosterWithLeftover()
		const record = JSON.stringify({ pid: process.pid, token: 'held', bootId: BOOT_ID })
		await writeFile(paths.lock, record, { mode: 0o600 })
		await setWrittenBeforeBoot(paths.lock)
		await AccessStore.open({ workspaceRoot: workspace, home })
		expect(await readdir(paths.dir)).toContain(leftover)
		expect(await readFile(paths.lock, 'utf8')).toBe(record)
	})

	it.each([
		['the pid of this live process', () => JSON.stringify({ pid: process.pid, token: 'held' })],
		['no bytes at all', () => ''],
	])('keeps a roster lock written since boot that records %s', async (_label, record) => {
		const { workspace, home, paths, leftover } = await rosterWithLeftover()
		await writeFile(paths.lock, record(), { mode: 0o600 })
		await AccessStore.open({ workspaceRoot: workspace, home })
		expect(await readdir(paths.dir)).toContain(leftover)
		expect(await readFile(paths.lock, 'utf8')).toBe(record())
	})
})

describe('server hold staleness by boot', () => {
	async function holdOf(pid: number, options: Readonly<{ host?: string; bootId?: string }> = {}) {
		const root = await temporaryDirectory('uiux-boot-hold-')
		const path = join(root, CURRENT_TEST_LAYOUT.serverHoldPath)
		const token = randomUUID()
		const bootId = options.bootId ? { bootId: options.bootId } : {}
		await writeFile(path, `${JSON.stringify({ pid, hostname: options.host ?? hostname(), startedAt: new Date().toISOString(), token, ...bootId })}\n`)
		return { root, path, token }
	}

	it.each([
		['the pid of this live process', process.pid],
		['pid 1, which answers EPERM or is alive', 1],
	])('ignores a hold of this host without a boot identifier written before the current boot that records %s', async (_label, pid) => {
		const { root, path } = await holdOf(pid)
		await setWrittenBeforeBoot(path)
		expect(await readActiveServerHold(root, CURRENT_TEST_LAYOUT)).toBeUndefined()
	})

	it('records the current boot identifier in the hold it acquires', async () => {
		const root = await temporaryDirectory('uiux-boot-hold-')
		await writeFile(join(root, CURRENT_TEST_LAYOUT.manifestPath), '{}\n')
		const acquired = await acquireServerHold(root, { layout: CURRENT_TEST_LAYOUT })
		try {
			expect(acquired?.hold.bootId).toBe(BOOT_ID)
			expect(JSON.parse(await readFile(join(root, CURRENT_TEST_LAYOUT.serverHoldPath), 'utf8')).bootId).toBe(BOOT_ID)
			expect((await readActiveServerHold(root, CURRENT_TEST_LAYOUT))?.token).toBe(acquired?.hold.token)
		}
		finally { await acquired?.release() }
	})

	it('ignores a hold of this host that records another boot, even with a live pid and a fresh time', async () => {
		const { root } = await holdOf(process.pid, { bootId: randomUUID() })
		expect(await readActiveServerHold(root, CURRENT_TEST_LAYOUT)).toBeUndefined()
	})

	it.skipIf(BOOT_ID === undefined)('keeps a live hold that records the current boot although its time lies before boot (a clock step)', async () => {
		const { root, path, token } = await holdOf(process.pid, { bootId: BOOT_ID })
		await setWrittenBeforeBoot(path)
		expect((await readActiveServerHold(root, CURRENT_TEST_LAYOUT))?.token).toBe(token)
	})

	it('keeps a live hold of this host written since boot', async () => {
		const { root, token } = await holdOf(process.pid)
		expect((await readActiveServerHold(root, CURRENT_TEST_LAYOUT))?.token).toBe(token)
	})

	it('keeps a hold recorded by another host, whose boot this host cannot know', async () => {
		const { root, path, token } = await holdOf(process.pid, { host: `${hostname()}-elsewhere` })
		await setWrittenBeforeBoot(path)
		expect((await readActiveServerHold(root, CURRENT_TEST_LAYOUT))?.token).toBe(token)
	})
})
