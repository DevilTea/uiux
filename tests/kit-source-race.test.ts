import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { locateKitProject } from '../src/adapters/kit-registry'
import { listKitFiles, readKitFile } from '../src/adapters/kit-source-files'

/**
 * Deterministic interleavings of a local user swapping `kit/src` for a symbolic link while a kit
 * file is read or listed (Rule 01a13d3e-e253-76b7-84e5-5f3fb167b635). `node:fs/promises` is wrapped
 * so a test can act between two file system calls of the code under test; without a hook every
 * call passes straight through.
 */
const hooks = vi.hoisted(() => ({
	afterRealpath: undefined as ((path: string) => Promise<void>) | undefined,
	beforeReaddir: undefined as ((path: string) => Promise<void>) | undefined,
	beforeLstat: undefined as ((path: string) => Promise<void>) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	const wrapped = {
		...actual,
		realpath: (async (path: string, ...rest: unknown[]) => {
			const result = await (actual.realpath as (...args: unknown[]) => Promise<string>)(path, ...rest)
			await hooks.afterRealpath?.(String(path))
			return result
		}) as typeof actual.realpath,
		readdir: (async (path: string, ...rest: unknown[]) => {
			await hooks.beforeReaddir?.(String(path))
			return (actual.readdir as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
		}) as typeof actual.readdir,
		lstat: (async (path: string, ...rest: unknown[]) => {
			await hooks.beforeLstat?.(String(path))
			return (actual.lstat as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
		}) as typeof actual.lstat,
	}
	return { ...wrapped, default: wrapped }
})

const roots: string[] = []

afterEach(async () => {
	hooks.afterRealpath = undefined
	hooks.beforeReaddir = undefined
	hooks.beforeLstat = undefined
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, content)
}

/** A Workspace whose `kit/src/ds/` holds `Button.vue`, and a decoy outside it shaped like `kit/src/`. */
async function fixture() {
	const base = await realpath(await mkdtemp(join(tmpdir(), 'uiux-kit-race-')))
	roots.push(base)
	const workspace = join(base, 'workspace')
	const kit = join(workspace, 'kit')
	await write(join(kit, 'src', 'ds', 'Button.vue'), 'BUTTON\n')
	await write(join(base, 'decoy', 'ds', 'Button.vue'), 'SECRET\n')
	await write(join(base, 'decoy', 'ds', 'Secret.vue'), 'SECRET\n')
	const source = join(kit, 'src')
	const moved = join(kit, 'src-moved')
	let swapped = false
	const swap = async () => {
		await rename(source, moved)
		await symlink(join(base, 'decoy'), source)
		swapped = true
	}
	const restore = async () => {
		await rm(source)
		await rename(moved, source)
		swapped = false
	}
	return { kit, source, swap, restore, isSwapped: () => swapped, project: await locateKitProject(workspace, 'kit') }
}

// Only darwin (O_NOFOLLOW_ANY) and linux (/proc/self/fd) bind the open file to kit/; elsewhere the
// path checks after the open stay raceable (the Rule's Implementation gaps).
const BOUND = process.platform === 'darwin' || process.platform === 'linux'

describe('a kit/src swapped for a link around the checks of the open file', () => {
	it.runIf(BOUND)('refuses the decoy opened through the link even when the path checks after the open see kit/', async () => {
		const ctx = await fixture()
		// 1. the link is in place for the open, so the open file is the decoy's;
		// 2. kit/src is back when the path is resolved, so the real path lies inside kit/;
		// 3. the link is in place again when that real path is examined, so it names the decoy.
		hooks.afterRealpath = async (path) => {
			if (!path.endsWith('Button.vue')) return
			hooks.afterRealpath = undefined
			await ctx.swap()
		}
		const outcome = await readKitFile(ctx.project, 'src/ds/Button.vue', { beforeOpen: ctx.swap, afterOpen: ctx.restore })
		if (ctx.isSwapped()) await ctx.restore()
		expect(outcome).toEqual({ status: 'not_found' })
		const again = await readKitFile(ctx.project, 'src/ds/Button.vue')
		expect(again.status === 'found' && Buffer.from(again.bytes).toString()).toBe('BUTTON\n')
	})

	it.runIf(BOUND)('lists no file of a directory swapped for a link while its entries are read', async () => {
		const ctx = await fixture()
		const ds = join(ctx.source, 'ds')
		hooks.beforeReaddir = async (path) => {
			if (path !== ds) return
			hooks.beforeReaddir = undefined
			await ctx.swap()
		}
		// The link is gone again when the directory is examined after its entries were read.
		hooks.beforeLstat = async (path) => {
			if (path === ds && ctx.isSwapped()) await ctx.restore()
		}
		const listed = await listKitFiles(ctx.project)
		hooks.beforeLstat = undefined
		if (ctx.isSwapped()) await ctx.restore()
		expect(listed.files.map(file => file.path)).not.toContain('src/ds/Secret.vue')
		expect((await listKitFiles(ctx.project)).files.map(file => file.path)).toEqual(['src/ds/Button.vue'])
	})
})
