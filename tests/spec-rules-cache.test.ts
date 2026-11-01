import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSpecClient } from '@deviltea/spec-tool'
import { afterEach, describe, expect, it } from 'vitest'

import { createCachedGitWorkTreeRoot, readRequirementsProvider } from '../src/application/services/requirements-provider'
import { createSpecRulesCache, fileSystemSpecWorkspace, type SpecWorkspaceSource } from '../src/application/services/spec-rules-cache'

/**
 * Issue #390: reads of the `spec` requirements provider are cached by a cheap change signal of
 * `.spec/`, the Git work tree root is cached per directory, and a held Spec Tool writer lock caps the
 * wait instead of the 30 s of the Spec Tool reader. Clause 01a18120-f903-7f8d-9b44-d581ab520c0d has no
 * status for stale data, so a changed workspace is never served from the cache.
 */

const temporary: string[] = []

afterEach(async () => {
	await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

type Fake = SpecWorkspaceSource & {
	calls: { signature: number; writerActive: number; readRules: number }
	state: { signature: string; writer: boolean; rules: ReadonlyMap<string, string>; hang: boolean; fail?: Error }
}

/** A Spec Tool workspace whose signature, lock and Rules the test moves; `hang` stands for a reader waiting on a writer. */
function fakeSource(rules: Record<string, string> = { 'rule-1': 'One.' }): Fake {
	const calls = { signature: 0, writerActive: 0, readRules: 0 }
	const state: Fake['state'] = { signature: 'v1', writer: false, rules: new Map(Object.entries(rules)), hang: false }
	return {
		calls,
		state,
		async signature() { calls.signature++; return state.signature },
		async writerActive() { calls.writerActive++; return state.writer },
		async readRules() {
			calls.readRules++
			if (state.fail) throw state.fail
			if (state.hang) return new Promise<never>(() => undefined)
			return new Map(state.rules)
		},
	}
}

describe('the Spec Tool read cache', () => {
	it('serves an unchanged workspace without reading it again', async () => {
		const source = fakeSource()
		const cache = createSpecRulesCache(source)
		const first = await cache.read('/repo')
		const second = await cache.read('/repo')
		expect(first).toEqual({ ok: true, rules: new Map([['rule-1', 'One.']]) })
		expect(second).toEqual(first)
		expect(source.calls.readRules).toBe(1)
		// Another workspace has its own entry.
		await cache.read('/other')
		expect(source.calls.readRules).toBe(2)
	})

	it('reads again when the change signal moves, and serves the new Rules', async () => {
		const source = fakeSource()
		const cache = createSpecRulesCache(source)
		await cache.read('/repo')
		source.state.signature = 'v2'
		source.state.rules = new Map([['rule-1', 'One.'], ['rule-2', 'Two.']])
		const changed = await cache.read('/repo')
		expect(changed).toEqual({ ok: true, rules: new Map([['rule-1', 'One.'], ['rule-2', 'Two.']]) })
		expect(source.calls.readRules).toBe(2)
		await cache.read('/repo')
		expect(source.calls.readRules).toBe(2)
	})

	it('does not cache a read that overlapped a write, nor a failed read', async () => {
		const source = fakeSource()
		const cache = createSpecRulesCache(source)
		const original = source.readRules
		let raced = true
		// The signature moves while the first read runs.
		const racing: SpecWorkspaceSource = { ...source, async readRules(root) { const rules = await original(root); if (raced) { source.state.signature = 'v-during'; raced = false } return rules } }
		const racingCache = createSpecRulesCache(racing)
		await racingCache.read('/repo')
		await racingCache.read('/repo')
		expect(source.calls.readRules).toBe(2)

		source.state.fail = new Error('The workspace is invalid.')
		const failing = await cache.read('/other')
		expect(failing).toEqual({ ok: false, reason: 'The workspace is invalid.' })
		source.state.fail = undefined
		expect((await cache.read('/other')).ok).toBe(true)
	})

	it('serves an unchanged workspace while a writer holds the lock, without a wait', async () => {
		const source = fakeSource()
		const cache = createSpecRulesCache(source, { writerWaitMs: 20 })
		await cache.read('/repo')
		source.state.writer = true
		source.state.hang = true
		const started = Date.now()
		const result = await cache.read('/repo')
		expect(result.ok).toBe(true)
		expect(Date.now() - started).toBeLessThan(15)
		expect(source.calls.readRules).toBe(1)
	})

	it('caps the wait on a held writer lock and reports the provider unavailable, never the old Rules', async () => {
		const source = fakeSource()
		const cache = createSpecRulesCache(source, { writerWaitMs: 30, readTimeoutMs: 5_000 })
		await cache.read('/repo')
		// The writer changed a file and still holds its lock: the reader waits behind it.
		source.state.signature = 'v2'
		source.state.writer = true
		source.state.hang = true
		const started = Date.now()
		const held = await cache.read('/repo')
		expect(held.ok).toBe(false)
		expect(held.ok === false && held.reason).toContain('writer holds the workspace lock')
		expect(Date.now() - started).toBeLessThan(1_000)

		// Reads that overlap a hung read share it instead of starting a reader each.
		await cache.read('/repo')
		await cache.read('/repo')
		expect(source.calls.readRules).toBe(2)

		// The writer is done: the next read is current.
		source.state.writer = false
		source.state.hang = false
		source.state.rules = new Map([['rule-9', 'Nine.']])
		const settled = await createSpecRulesCache(source).read('/repo')
		expect(settled).toEqual({ ok: true, rules: new Map([['rule-9', 'Nine.']]) })
	})

	it('waits the longer read timeout when no writer holds the lock', async () => {
		const source = fakeSource()
		const cache = createSpecRulesCache(source, { writerWaitMs: 5, readTimeoutMs: 40 })
		source.state.hang = true
		const started = Date.now()
		const result = await cache.read('/repo')
		expect(result.ok).toBe(false)
		expect(result.ok === false && result.reason).toBe('The Spec Tool workspace did not answer in time.')
		expect(Date.now() - started).toBeGreaterThanOrEqual(35)
	})

	it('shares one read between concurrent requests', async () => {
		const source = fakeSource()
		const cache = createSpecRulesCache(source)
		const results = await Promise.all([cache.read('/repo'), cache.read('/repo'), cache.read('/repo')])
		expect(results.every(result => result.ok)).toBe(true)
		expect(source.calls.readRules).toBe(1)
	})
})

describe('the provider read through the cache', () => {
	it('asks Spec Tool once for repeated reads of one Workspace and keeps the status of a read provider', async () => {
		const source = fakeSource({ 'rule-1': 'One.' })
		const repo = await mkdtemp(join(tmpdir(), 'uiux-provider-cache-'))
		temporary.push(repo)
		await mkdir(join(repo, '.spec'))
		const options = { gitWorkTreeRoot: async () => repo, specRulesCache: createSpecRulesCache(source) }
		const setting = { provider: 'spec', path: '.spec', noUi: {} } as never
		for (let index = 0; index < 5; index++) {
			const read = await readRequirementsProvider(repo, setting, options)
			expect(read.status).toBe('ok')
		}
		expect(source.calls.readRules).toBe(1)
		source.state.signature = 'v2'
		source.state.hang = true
		source.state.writer = true
		const capped = await readRequirementsProvider(repo, setting, { ...options, specRulesCache: createSpecRulesCache(source, { writerWaitMs: 10 }) })
		expect(capped.status).toBe('unavailable')
	})
})

describe('the Git work tree root cache', () => {
	it('spawns once per directory within its lifetime and again after it', async () => {
		let spawned = 0
		let clock = 1_000
		const ask = createCachedGitWorkTreeRoot(async (directory) => { spawned++; return `${directory}/..` }, 100, () => clock)
		expect(await ask('/a/b')).toBe('/a/b/..')
		expect(await ask('/a/b')).toBe('/a/b/..')
		expect(await ask('/c')).toBe('/c/..')
		expect(spawned).toBe(2)
		clock += 99
		await ask('/a/b')
		expect(spawned).toBe(2)
		clock += 1
		await ask('/a/b')
		expect(spawned).toBe(3)
	})

	it('shares the spawn of overlapping asks and asks again outside a work tree', async () => {
		let spawned = 0
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => { release = resolve })
		let inside = false
		const ask = createCachedGitWorkTreeRoot(async () => { spawned++; await gate; return inside ? '/work' : undefined })
		const overlapping = [ask('/x'), ask('/x')]
		release?.()
		expect(await Promise.all(overlapping)).toEqual([undefined, undefined])
		expect(spawned).toBe(1)
		// Not a work tree yet: nothing is remembered, so a later `git init` is seen at once.
		inside = true
		expect(await ask('/x')).toBe('/work')
		expect(spawned).toBe(2)
		expect(await ask('/x')).toBe('/work')
		expect(spawned).toBe(2)
	})
})

describe('the file system change signal of a Spec Tool workspace', () => {
	/**
	 * The file system workspace, remembering every read it starts. A read the cache gave up on keeps
	 * running (it waits for the writer lock the test holds) and, once the lock is gone, writes reader
	 * tokens beside `.spec/`: a test settles those reads before its directory is removed, or the
	 * removal races them (ENOTEMPTY, issue #263).
	 */
	function trackedWorkspace(): { source: SpecWorkspaceSource; settle: () => Promise<void> } {
		const reads: Promise<unknown>[] = []
		return {
			source: { ...fileSystemSpecWorkspace, readRules: (root) => { const read = fileSystemSpecWorkspace.readRules(root); reads.push(read); return read } },
			settle: async () => { await Promise.allSettled(reads) },
		}
	}

	async function workspace(): Promise<{ root: string; client: ReturnType<typeof createSpecClient>; revision: string; feature: string }> {
		const root = await mkdtemp(join(tmpdir(), 'uiux-spec-signal-'))
		temporary.push(root)
		const client = createSpecClient(root)
		let response = await client.workspace.init()
		response = await client.feature.create({ expectedRevision: response.revision, title: 'Feature', summary: 'A feature.' })
		const feature = response.changedNodes[0]!.id
		response = await client.rule.create({ expectedRevision: response.revision, ownerId: feature, statement: 'Rule 1 states a behavior.' })
		return { root, client, revision: response.revision, feature }
	}

	it('moves with every change of the workspace and holds still otherwise', async () => {
		const { root, client, revision, feature } = await workspace()
		const before = await fileSystemSpecWorkspace.signature(root)
		expect(await fileSystemSpecWorkspace.signature(root)).toBe(before)
		const added = await client.rule.create({ expectedRevision: revision, ownerId: feature, statement: 'Rule 2 states a behavior.' })
		const afterAdd = await fileSystemSpecWorkspace.signature(root)
		expect(afterAdd).not.toBe(before)
		const updated = await client.rule.update({ expectedRevision: added.revision, id: added.changedNodes.find(node => node.kind === 'rule')!.id, changes: { statement: 'Rule 2 states another behavior.' } })
		const afterUpdate = await fileSystemSpecWorkspace.signature(root)
		expect(afterUpdate).not.toBe(afterAdd)
		await client.rule.delete({ expectedRevision: updated.revision, id: added.changedNodes.find(node => node.kind === 'rule')!.id })
		expect(await fileSystemSpecWorkspace.signature(root)).not.toBe(afterUpdate)
		// A file touched without a content change still moves it (the modification time is part of it).
		const settled = await fileSystemSpecWorkspace.signature(root)
		const touched = join(root, '.spec', 'spec.yaml')
		await utimes(touched, new Date(Date.now() + 5_000), new Date(Date.now() + 5_000))
		expect(await fileSystemSpecWorkspace.signature(root)).not.toBe(settled)
	})

	it('misses an in-place rewrite that keeps the inode, the size and the modification time', async () => {
		const { root } = await workspace()
		const cache = createSpecRulesCache(fileSystemSpecWorkspace)
		const features = join(root, '.spec', 'features')
		const file = join(features, (await readdir(features)).find(name => name.endsWith('.md'))!)
		// A whole-second time, which a restore reproduces exactly.
		const fixed = new Date('2026-01-01T00:00:00Z')
		await utimes(file, fixed, fixed)
		const first = await cache.read(root)
		expect(first.ok && [...first.rules.values()]).toEqual(['Rule 1 states a behavior.'])
		const before = await fileSystemSpecWorkspace.signature(root)
		const original = await stat(file)
		const text = await readFile(file, 'utf8')
		const rewritten = text.replace('Rule 1 states a behavior.', 'Rule 9 states a behavior.')
		expect(rewritten).not.toBe(text)
		expect(rewritten.length).toBe(text.length)
		// Truncating the same file keeps its inode; restoring the times is what `cp -p` or `touch -r` do.
		await writeFile(file, rewritten)
		await utimes(file, fixed, fixed)
		const after = await stat(file)
		expect([after.ino, after.size, after.mtimeMs]).toEqual([original.ino, original.size, original.mtimeMs])

		expect(await fileSystemSpecWorkspace.signature(root)).not.toBe(before)
		const changed = await cache.read(root)
		expect(changed.ok && [...changed.rules.values()]).toEqual(['Rule 9 states a behavior.'])
	})

	it('sees the writer lock beside `.spec/` and serves a real workspace from the cache', async () => {
		const { root, client, revision, feature } = await workspace()
		expect(await fileSystemSpecWorkspace.writerActive(root)).toBe(false)
		const tracked = trackedWorkspace()
		const cache = createSpecRulesCache(tracked.source, { writerWaitMs: 50 })
		const first = await cache.read(root)
		expect(first.ok && [...first.rules.values()]).toEqual(['Rule 1 states a behavior.'])

		await mkdir(join(root, '.spec-tool-v1.lock'))
		expect(await fileSystemSpecWorkspace.writerActive(root)).toBe(true)
		// Unchanged `.spec/`: served at once while the writer holds the lock.
		expect(await cache.read(root)).toEqual(first)
		// A file written under the lock: a reader waits behind the writer only for the cap, then the provider is unavailable.
		await writeFile(join(root, '.spec', 'features', 'note.txt'), 'x')
		const started = Date.now()
		const held = await cache.read(root)
		expect(held.ok).toBe(false)
		expect(Date.now() - started).toBeLessThan(1_000)
		await rm(join(root, '.spec', 'features', 'note.txt'))
		await rm(join(root, '.spec-tool-v1.lock'), { recursive: true })

		// After the writer: a real change is read, not served from the cache.
		await client.rule.create({ expectedRevision: revision, ownerId: feature, statement: 'Rule 2 states a behavior.' })
		const changed = await cache.read(root)
		expect(changed.ok && [...changed.rules.values()].sort()).toEqual(['Rule 1 states a behavior.', 'Rule 2 states a behavior.'])
		await tracked.settle()
	})
})
