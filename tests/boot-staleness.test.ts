import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readActiveServerHold } from '../src/persistence'
import { BOOT_STALENESS_TOLERANCE_MS, currentBootTimeMs, predatesCurrentBoot } from '../src/persistence/boot-staleness'
import { AccessStore, accessStorePaths } from '../src/server/access/store'
import { CURRENT_TEST_LAYOUT } from './support/workspace-layout'

// Owner ruling 2026-10-23 (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19145490):
// a host lock or hold file written before the current boot is stale whatever it records.

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

describe('roster lock staleness by boot time', () => {
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
	])('clears a roster lock written before the current boot that records %s', async (_label, record) => {
		const { workspace, home, paths, leftover } = await rosterWithLeftover()
		await writeFile(paths.lock, record(), { mode: 0o600 })
		await setWrittenBeforeBoot(paths.lock)
		await AccessStore.open({ workspaceRoot: workspace, home })
		const names = await readdir(paths.dir)
		expect(names).not.toContain(leftover)
		expect(await readFile(paths.lock).catch(error => error.code)).toBe('ENOENT')
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

describe('server hold staleness by boot time', () => {
	async function holdOf(pid: number, options: Readonly<{ host?: string }> = {}) {
		const root = await temporaryDirectory('uiux-boot-hold-')
		const path = join(root, CURRENT_TEST_LAYOUT.serverHoldPath)
		const token = randomUUID()
		await writeFile(path, `${JSON.stringify({ pid, hostname: options.host ?? hostname(), startedAt: new Date().toISOString(), token })}\n`)
		return { root, path, token }
	}

	it.each([
		['the pid of this live process', process.pid],
		['pid 1, which answers EPERM or is alive', 1],
	])('ignores a hold of this host written before the current boot that records %s', async (_label, pid) => {
		const { root, path } = await holdOf(pid)
		await setWrittenBeforeBoot(path)
		expect(await readActiveServerHold(root, CURRENT_TEST_LAYOUT)).toBeUndefined()
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
