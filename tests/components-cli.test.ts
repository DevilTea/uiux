import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runComponentsCommand } from '../src/cli/components'
import { runInitCommand } from '../src/cli/init'
import { componentClosure } from '../src/domain/product-kit/closure'
import { caseOnlyCollisions, driftState, hasGitSegment, validateCopyRecord } from '../src/domain/product-kit/copy-record'
import { componentDigest, fileDigest } from '../src/domain/product-kit/digest'
import { emptyProductKit, type ProductKit } from '../src/domain/product-kit/schema'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

/**
 * `uiux components list|add|diff` (Clauses 01a11bb1-9b24-…, 01a11bb1-9b89-…, 01a11bb1-9bef-…,
 * 01a11bb1-9c51-…, 01a11bb1-8b0c-…, 01a11bb1-8bd0-…, 01a11bb1-8c36-… and 01a11bb1-8c9b-…, and the
 * copy Rules of the Product Kit Feature): the copy record, drift, forced moves and the containment
 * refusals on both the kit and the product project side.
 */
const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'uiux.mjs')
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const BUTTON = '<script setup lang="ts">\ndefineProps<{ label: string }>()\n</script>\n<template><button>{{ label }}</button></template>\n'
const BADGE = '<template><span class="badge"><slot /></span></template>\n'
const CARD = '<script setup lang="ts">\nimport Button from \'../ds/Button.vue\'\n</script>\n<template><section><Button label="Pay" /></section></template>\n'

const REGISTRY: ProductKit['components'] = {
	'button': { files: ['src/ds/Button.vue'], packages: ['vue'], layer: 'design-system' },
	'badge': { files: ['src/ds/Badge.vue'], layer: 'design-system' },
	'order-summary-card': { files: ['src/product/OrderSummaryCard.vue'], requires: ['button'], packages: ['vue'], layer: 'product' },
}

type Fixture = Readonly<{ base: string; workspace: string; kit: string; project: string; home: string }>

/** A temporary Workspace (with its own UIUX_HOME) holding the registry above, and a product project beside it. */
async function makeFixture(components: ProductKit['components'] = REGISTRY): Promise<Fixture> {
	const base = await realpath(await mkdtemp(join(tmpdir(), 'uiux-components-')))
	roots.push(base)
	const workspace = join(base, 'workspace')
	const home = join(base, 'home')
	expect(await runInitCommand({ workspace, env: { UIUX_HOME: home }, stdout: () => {}, stderr: () => {} })).toBe(0)
	const kit = join(workspace, 'kit')
	await writeKitFile(kit, 'src/ds/Button.vue', BUTTON)
	await writeKitFile(kit, 'src/ds/Badge.vue', BADGE)
	await writeKitFile(kit, 'src/product/OrderSummaryCard.vue', CARD)
	await writeFile(join(kit, 'package.json'), JSON.stringify({ name: 'kit', private: true, dependencies: { vue: '^3.5.0' } }))
	await setRegistry(workspace, components)
	const project = join(base, 'product')
	await mkdir(project)
	await writeFile(join(project, 'package.json'), '{ "name": "product" }\n')
	return { base, workspace, kit, project, home }
}

async function writeKitFile(kit: string, file: string, content: string): Promise<void> {
	await mkdir(dirname(join(kit, file)), { recursive: true })
	await writeFile(join(kit, file), content)
}

async function setRegistry(workspace: string, components: ProductKit['components']): Promise<void> {
	await writeFile(join(workspace, 'product-kit.json'), `${JSON.stringify({ ...emptyProductKit(), components }, null, 2)}\n`)
}

async function run(fixture: Fixture, argv: string[], cwd = fixture.project) {
	const stdout: string[] = []
	const stderr: string[] = []
	const code = await runComponentsCommand({
		argv: [...argv, '--workspace', fixture.workspace],
		cwd,
		stdout: line => stdout.push(line),
		stderr: line => stderr.push(line),
		now: () => new Date('2026-10-14T08:00:00.000Z'),
		gitToplevel: () => undefined,
	})
	return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

async function readRecord(project: string) {
	return JSON.parse(await readFile(join(project, 'uiux-components.json'), 'utf8'))
}

function sha256(content: string): string {
	return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

/** Every file below `directory` with its content, for "nothing changed" assertions. */
async function snapshot(directory: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {}
	const walk = async (path: string, rel: string) => {
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const child = join(path, entry.name)
			const childRel = rel ? `${rel}/${entry.name}` : entry.name
			if (entry.isDirectory()) {
				result[`${childRel}/`] = ''
				await walk(child, childRel)
			}
			else if (entry.isSymbolicLink()) result[childRel] = '<link>'
			else result[childRel] = await readFile(child, 'utf8')
		}
	}
	await walk(directory, '')
	return result
}

describe('Product Kit digests, closure and drift states', () => {
	it('computes file digests and the component digest over the canonical JSON of the file map', async () => {
		expect(await fileDigest(Buffer.from(BUTTON))).toBe(sha256(BUTTON))
		const files = { 'src/ds/b.ts': sha256('b'), 'src/ds/a.ts': sha256('a') }
		expect(await componentDigest(files)).toBe(sha256(`{"src/ds/a.ts":"${sha256('a')}","src/ds/b.ts":"${sha256('b')}"}\n`))
	})

	it('takes the requires closure once, through cycles, and names unknown components', () => {
		const registry = {
			a: { files: ['src/a.ts'], requires: ['b'], layer: 'product' as const },
			b: { files: ['src/b.ts'], requires: ['c', 'a'], layer: 'product' as const },
			c: { files: ['src/c.ts'], layer: 'product' as const },
		}
		expect(componentClosure({ components: registry }, ['a'])).toEqual({ ok: true, components: ['a', 'b', 'c'] })
		expect(componentClosure({ components: registry }, ['c', 'a'])).toEqual({ ok: true, components: ['c', 'a', 'b'] })
		expect(componentClosure({ components: registry }, ['a', 'nope'])).toEqual({ ok: false, unknown: ['nope'] })
	})

	it('reports one drift state per file', () => {
		const recorded = sha256('r')
		const other = sha256('o')
		expect(driftState({ recorded, copy: recorded, original: recorded })).toBe('unchanged')
		expect(driftState({ recorded, copy: other, original: recorded })).toBe('modified')
		expect(driftState({ recorded, copy: recorded, original: other })).toBe('upstream')
		expect(driftState({ recorded, copy: recorded, original: undefined })).toBe('upstream')
		expect(driftState({ recorded, copy: other, original: other })).toBe('diverged')
		expect(driftState({ recorded, copy: undefined, original: recorded })).toBe('missing')
		expect(driftState({ recorded, copy: undefined, original: 'removed' })).toBe('removed')
	})

	it('refuses a copy record whose paths leave the project, the kit sources or their target', () => {
		const entry = (files: Record<string, unknown>, target = 'src/ui') => ({ formatVersion: 1, components: { button: { target, componentDigest: sha256('c'), exportedAt: '2026-10-14T08:00:00.000Z', files } } })
		expect(validateCopyRecord(entry({ 'src/ui/ds/Button.vue': { source: 'src/ds/Button.vue', digest: sha256('b') } })).ok).toBe(true)
		expect(validateCopyRecord(entry({ '../x/ds/Button.vue': { source: 'src/ds/Button.vue', digest: sha256('b') } }, '../x')).ok).toBe(false)
		expect(validateCopyRecord(entry({ '/etc/ds/Button.vue': { source: 'src/ds/Button.vue', digest: sha256('b') } }, '/etc')).ok).toBe(false)
		expect(validateCopyRecord(entry({ 'src/ui/x': { source: 'src/../../x', digest: sha256('b') } })).ok).toBe(false)
		expect(validateCopyRecord(entry({ 'src/other/ds/Button.vue': { source: 'src/ds/Button.vue', digest: sha256('b') } })).ok).toBe(false)
		expect(validateCopyRecord(entry({ 'src/ui/package.json': { source: 'package.json', digest: sha256('b') } })).ok).toBe(false)
	})

	it('finds paths that differ only in letter case or normalization, and .git segments in any case', () => {
		expect(caseOnlyCollisions(['src/ui/ds/button.vue', 'src/ui/ds/Button.vue', 'src/ui/ds/Badge.vue', 'src/ui/ds/button.vue'])).toEqual([['src/ui/ds/button.vue', 'src/ui/ds/Button.vue']])
		expect(caseOnlyCollisions(['src/UI/ds/Button.vue', 'src/ui/ds/Button.vue'])).toEqual([['src/UI/ds/Button.vue', 'src/ui/ds/Button.vue']])
		expect(caseOnlyCollisions(['src/café.vue', 'src/café.vue'])).toEqual([['src/café.vue', 'src/café.vue']])
		expect(caseOnlyCollisions(['src/ui/a.vue', 'src/ui/b.vue'])).toEqual([])
		// The long s folds to s in upper case, as segmentNamesInAnyCase compares.
		expect(caseOnlyCollisions(['src/a/Foſ.vue', 'src/a/Fos.vue'])).toEqual([['src/a/Foſ.vue', 'src/a/Fos.vue']])
		expect(caseOnlyCollisions(['src/a/FOS.vue', 'src/a/foſ.vue'])).toEqual([['src/a/FOS.vue', 'src/a/foſ.vue']])
		expect(hasGitSegment('.git')).toBe(true)
		expect(hasGitSegment('vendor/.GIT/config')).toBe(true)
		expect(hasGitSegment('src/.gitkeep')).toBe(false)
	})
})

describe('uiux components', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('lists the registry components', async () => {
		const fixture = await makeFixture()
		const result = await run(fixture, ['list'])
		expect(result.code, result.stderr).toBe(0)
		expect(result.stdout.split('\n')).toEqual([
			'badge  design-system; 1 file',
			'button  design-system; 1 file; packages vue',
			'order-summary-card  product; 1 file; requires button; packages vue',
		])
	})

	// Scenario 01a11bb1-c118-79ab-bc18-bcdfc259021b.
	it('copies a component under its kit/src path and records it in the project copy record', async () => {
		const fixture = await makeFixture()
		const result = await run(fixture, ['add', 'button', '--to', 'src/ui'])
		expect(result.code, result.stderr).toBe(0)
		expect(await readFile(join(fixture.project, 'src/ui/ds/Button.vue'), 'utf8')).toBe(BUTTON)
		const files = { 'src/ui/ds/Button.vue': { source: 'src/ds/Button.vue', digest: sha256(BUTTON) } }
		expect(await readRecord(fixture.project)).toEqual({
			formatVersion: 1,
			components: {
				button: { target: 'src/ui', componentDigest: await componentDigest({ 'src/ds/Button.vue': sha256(BUTTON) }), exportedAt: '2026-10-14T08:00:00.000Z', files },
			},
		})
		expect(result.stdout).toContain('  vue@^3.5.0')
		// Clause 01a11bb1-8c36-…: the record names no Workspace path or identity.
		const text = await readFile(join(fixture.project, 'uiux-components.json'), 'utf8')
		expect(text).not.toContain(fixture.base)
		expect(text).not.toContain('workspace')
		// Rule 01a11bb1-a50a-…: only the record and the target are written.
		expect(Object.keys(await snapshot(fixture.project)).sort()).toEqual(['package.json', 'src/', 'src/ui/', 'src/ui/ds/', 'src/ui/ds/Button.vue', 'uiux-components.json'])
		// Rule 01a11bb1-a5cf-…: no record in the Workspace.
		expect(Object.keys(await snapshot(fixture.workspace)).some(path => path.includes('uiux-components'))).toBe(false)
	})

	// Scenario 01a11bb1-c182-7ae7-9b5a-5fdd3684ecee.
	it('adds a component copied to another directory to the same copy record', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'button', '--to', 'src/ui'])).code).toBe(0)
		const result = await run(fixture, ['add', 'badge', '--to', 'src/features/orders'])
		expect(result.code, result.stderr).toBe(0)
		const record = await readRecord(fixture.project)
		expect(Object.fromEntries(Object.entries(record.components).map(([name, entry]) => [name, (entry as { target: string }).target]))).toEqual({ button: 'src/ui', badge: 'src/features/orders' })
		expect(await readFile(join(fixture.project, 'src/features/orders/ds/Badge.vue'), 'utf8')).toBe(BADGE)
	})

	it('copies the requires closure so relative imports between copies resolve, and is idempotent', async () => {
		const fixture = await makeFixture()
		const first = await run(fixture, ['add', 'order-summary-card', '--to', 'src/features/orders'])
		expect(first.code, first.stderr).toBe(0)
		const card = join(fixture.project, 'src/features/orders/product/OrderSummaryCard.vue')
		expect(await readFile(card, 'utf8')).toBe(CARD)
		// Rule 01a11c09-d0d9-…: `../ds/Button.vue` from the card resolves to the copied button.
		expect(await readFile(join(dirname(card), '../ds/Button.vue'), 'utf8')).toBe(BUTTON)
		expect(first.stdout.match(/vue@/gu)).toHaveLength(1)
		const before = await readFile(join(fixture.project, 'uiux-components.json'), 'utf8')
		const again = await runComponentsCommand({ argv: ['add', 'order-summary-card', '--to', 'src/features/orders', '--workspace', fixture.workspace], cwd: fixture.project, stdout: () => {}, stderr: () => {}, now: () => new Date('2027-01-01T00:00:00.000Z'), gitToplevel: () => undefined })
		expect(again).toBe(0)
		expect(await readFile(join(fixture.project, 'uiux-components.json'), 'utf8')).toBe(before)
	})

	// Scenario 01a11be8-5a84-78f6-9bbb-b24985d42c5b.
	it('refuses, naming the recorded target, when a required component is copied elsewhere, and changes nothing', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'button', '--to', 'src/ui'])).code).toBe(0)
		const before = await snapshot(fixture.project)
		const result = await run(fixture, ['add', 'order-summary-card', '--to', 'src/features/orders'])
		expect(result.code).toBe(1)
		expect(result.stderr).toContain('button (required by order-summary-card) is already copied to src/ui')
		expect(await snapshot(fixture.project)).toEqual(before)
	})

	// Rule 01a11be8-5931-…: a forced add moves the recorded component, files and entry, to the new target.
	it('moves a component recorded at another target with --force, and never copies it twice', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'button', '--to', 'src/ui'])).code).toBe(0)
		const result = await run(fixture, ['add', 'order-summary-card', '--to', 'src/features/orders', '--force'])
		expect(result.code, result.stderr).toBe(0)
		expect(result.stdout).toContain('Moved button from src/ui to src/features/orders.')
		expect(await lstat(join(fixture.project, 'src/ui/ds/Button.vue')).catch(() => undefined)).toBeUndefined()
		expect(await lstat(join(fixture.project, 'src/ui/ds')).catch(() => undefined)).toBeUndefined()
		expect(await readFile(join(fixture.project, 'src/features/orders/ds/Button.vue'), 'utf8')).toBe(BUTTON)
		const record = await readRecord(fixture.project)
		expect(record.components.button.target).toBe('src/features/orders')
		expect(Object.keys(record.components.button.files)).toEqual(['src/features/orders/ds/Button.vue'])
		const copies = Object.keys(await snapshot(fixture.project)).filter(path => path.endsWith('Button.vue'))
		expect(copies).toEqual(['src/features/orders/ds/Button.vue'])
	})

	it('refuses, even forced, a move that would leave a recorded component requiring a moved one', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'order-summary-card', '--to', 'src/ui'])).code).toBe(0)
		const before = await snapshot(fixture.project)
		const result = await run(fixture, ['add', 'button', '--to', 'src/elsewhere', '--force'])
		expect(result.code).toBe(1)
		expect(result.stderr).toContain('order-summary-card, copied to src/ui, requires button')
		expect(await snapshot(fixture.project)).toEqual(before)
	})

	// Rule 01a11bb1-a444-…: a modified copy is overwritten only when forced.
	it('refuses to overwrite a modified copy or an unrecorded file unless forced', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'button', '--to', 'src/ui'])).code).toBe(0)
		await writeKitFile(fixture.kit, 'src/ds/Button.vue', `${BUTTON}<!-- v2 -->\n`)
		await writeFile(join(fixture.project, 'src/ui/ds/Button.vue'), 'local edit\n')
		const refused = await run(fixture, ['add', 'button', '--to', 'src/ui'])
		expect(refused.code).toBe(1)
		expect(refused.stderr).toContain('src/ui/ds/Button.vue was changed since it was copied')
		expect(await readFile(join(fixture.project, 'src/ui/ds/Button.vue'), 'utf8')).toBe('local edit\n')
		const forced = await run(fixture, ['add', 'button', '--to', 'src/ui', '--force'])
		expect(forced.code, forced.stderr).toBe(0)
		expect(await readFile(join(fixture.project, 'src/ui/ds/Button.vue'), 'utf8')).toBe(`${BUTTON}<!-- v2 -->\n`)

		await writeKitFile(fixture.project, 'src/lib/ds/Badge.vue', 'mine\n')
		const unrecorded = await run(fixture, ['add', 'badge', '--to', 'src/lib'])
		expect(unrecorded.code).toBe(1)
		expect(unrecorded.stderr).toContain('src/lib/ds/Badge.vue already exists and is not a recorded copy')
	})

	// Scenario 01a11bb1-c1e6-7fdf-bcae-6579414fab33.
	it('reports an edited copy as modified, and diff --check exits 1', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'button', '--to', 'src/ui'])).code).toBe(0)
		const clean = await run(fixture, ['diff', '--check'])
		expect(clean.code, clean.stderr).toBe(0)
		expect(clean.stdout).toContain('unchanged src/ui/ds/Button.vue (button)')
		await writeFile(join(fixture.project, 'src/ui/ds/Button.vue'), 'edited\n')
		const result = await run(fixture, ['diff', '--check'])
		expect(result.code).toBe(1)
		expect(result.stdout).toContain('modified  src/ui/ds/Button.vue (button)')
	})

	// Scenario 01a11bb1-c24c-73ad-814c-afc65ba50011.
	it('reports an edited Workspace original as upstream', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'button', '--to', 'src/ui'])).code).toBe(0)
		await writeKitFile(fixture.kit, 'src/ds/Button.vue', 'upstream edit\n')
		const result = await run(fixture, ['diff'])
		expect(result.code).toBe(0)
		expect(result.stdout).toContain('upstream  src/ui/ds/Button.vue (button)')
	})

	it('reports diverged, missing and removed files', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'order-summary-card', 'badge', '--to', 'src/ui'])).code).toBe(0)
		await writeKitFile(fixture.kit, 'src/ds/Button.vue', 'upstream\n')
		await writeFile(join(fixture.project, 'src/ui/ds/Button.vue'), 'local\n')
		await rm(join(fixture.project, 'src/ui/ds/Badge.vue'))
		await setRegistry(fixture.workspace, Object.fromEntries(Object.entries(REGISTRY).filter(([name]) => name !== 'order-summary-card')))
		const result = await run(fixture, ['diff', '--check'])
		expect(result.code).toBe(1)
		expect(result.stdout).toContain('diverged  src/ui/ds/Button.vue (button)')
		expect(result.stdout).toContain('missing   src/ui/ds/Badge.vue (badge)')
		expect(result.stdout).toContain('removed   src/ui/product/OrderSummaryCard.vue (order-summary-card)')
	})

	it('selects the product project: the nearest package.json at or above --to, --project, the current directory for diff, then Git', async () => {
		const fixture = await makeFixture()
		const nested = join(fixture.project, 'packages', 'app')
		await mkdir(nested, { recursive: true })
		await writeFile(join(nested, 'package.json'), '{}\n')
		expect((await run(fixture, ['add', 'badge', '--to', 'packages/app/src/ui'])).code).toBe(0)
		expect(Object.keys((await readRecord(nested)).components)).toEqual(['badge'])
		expect((await readRecord(nested)).components.badge.target).toBe('src/ui')
		expect((await run(fixture, ['add', 'button', '--to', 'packages/app/src/x', '--project', '.'])).code).toBe(0)
		expect((await readRecord(fixture.project)).components.button.target).toBe('packages/app/src/x')
		expect((await run(fixture, ['diff'], nested)).stdout).toContain('src/ui/ds/Badge.vue (badge)')

		const bare = join(fixture.base, 'bare')
		await mkdir(join(bare, 'deep'), { recursive: true })
		const none = await run(fixture, ['add', 'badge', '--to', join(bare, 'deep', 'ui')])
		expect(none.code).toBe(2)
		expect(none.stderr).toContain('No product project found')
		const viaGit = await runComponentsCommand({ argv: ['add', 'badge', '--to', 'deep/ui', '--workspace', fixture.workspace], cwd: bare, stdout: () => {}, stderr: () => {}, gitToplevel: () => bare })
		expect(viaGit).toBe(0)
		expect((await readRecord(bare)).components.badge.target).toBe('deep/ui')
	})

	it('refuses a target outside the product project, its root, or a target inside the Workspace', async () => {
		const fixture = await makeFixture()
		const outside = await run(fixture, ['add', 'badge', '--to', '../elsewhere', '--project', '.'])
		expect(outside.code).toBe(2)
		expect(outside.stderr).toContain('strictly inside the product project')
		expect((await run(fixture, ['add', 'badge', '--to', '.'])).code).toBe(2)
		const inWorkspace = await run(fixture, ['add', 'badge', '--to', join(fixture.workspace, 'copies'), '--project', fixture.base], fixture.base)
		expect(inWorkspace.code).toBe(2)
		expect(inWorkspace.stderr).toContain('lies inside the Workspace')
		await mkdir(join(fixture.workspace, 'sub'))
		const projectInWorkspace = await run(fixture, ['add', 'badge', '--to', 'x', '--project', '.'], join(fixture.workspace, 'sub'))
		expect(projectInWorkspace.code).toBe(2)
		expect(projectInWorkspace.stderr).toContain('the copy record is never kept in a Workspace')
		expect(await lstat(join(fixture.workspace, 'copies')).catch(() => undefined)).toBeUndefined()
		expect(await lstat(join(fixture.workspace, 'uiux-components.json')).catch(() => undefined)).toBeUndefined()
	})

	it('never writes through a symbolic link in the product project', async () => {
		const fixture = await makeFixture()
		const outside = join(fixture.base, 'outside')
		await mkdir(outside)
		await mkdir(join(fixture.project, 'src'))
		await symlink(outside, join(fixture.project, 'src', 'ui'))
		const linked = await run(fixture, ['add', 'badge', '--to', 'src/ui'])
		expect(linked.code).not.toBe(0)
		expect(await readdir(outside)).toEqual([])
		expect(await lstat(join(fixture.project, 'uiux-components.json')).catch(() => undefined)).toBeUndefined()

		await mkdir(join(fixture.project, 'src', 'lib'))
		await symlink(outside, join(fixture.project, 'src', 'lib', 'ds'))
		const below = await run(fixture, ['add', 'badge', '--to', 'src/lib'])
		expect(below.code).toBe(1)
		expect(below.stderr).toContain('src/lib/ds in the product project is a symbolic link')
		expect(await readdir(outside)).toEqual([])
	})

	it('refuses a kit file that is a symbolic link or lies below a linked directory, writing nothing', async () => {
		const fixture = await makeFixture({
			...REGISTRY,
			linked: { files: ['src/ds/Linked.vue'], layer: 'design-system' },
			nested: { files: ['src/shared/Secret.vue'], layer: 'design-system' },
		})
		const secret = join(fixture.base, 'secret')
		await mkdir(secret)
		await writeFile(join(secret, 'Secret.vue'), 'secret\n')
		await symlink(join(secret, 'Secret.vue'), join(fixture.kit, 'src/ds/Linked.vue'))
		await symlink(secret, join(fixture.kit, 'src/shared'))
		for (const name of ['linked', 'nested']) {
			const result = await run(fixture, ['add', name, '--to', 'src/ui'])
			expect(result.code).toBe(1)
			expect(result.stderr).toContain('is not a regular file under kit/src/ reached without a symbolic link')
		}
		expect(Object.keys(await snapshot(fixture.project))).toEqual(['package.json'])
	})

	it('refuses an unknown component and invalid usage', async () => {
		const fixture = await makeFixture()
		const unknown = await run(fixture, ['add', 'nope', '--to', 'src/ui'])
		expect(unknown.code).toBe(1)
		expect(unknown.stderr).toContain('no component nope')
		expect((await run(fixture, ['add', 'button'])).code).toBe(2)
		expect((await run(fixture, ['diff', '--to', 'x'])).code).toBe(2)
		expect((await run(fixture, ['remove'])).code).toBe(2)
	})

	it('runs through the uiux binary without a credential, and help lists the commands', async () => {
		const fixture = await makeFixture()
		const env = { ...process.env, UIUX_HOME: fixture.home }
		const add = spawnSync(process.execPath, [CLI, 'components', 'add', 'button', '--to', 'src/ui', '--workspace', fixture.workspace], { cwd: fixture.project, encoding: 'utf8', env })
		expect(add.status, add.stderr).toBe(0)
		await writeFile(join(fixture.project, posix.join('src/ui/ds/Button.vue')), 'edited\n')
		const diff = spawnSync(process.execPath, [CLI, 'components', 'diff', '--check', '--workspace', fixture.workspace], { cwd: fixture.project, encoding: 'utf8', env })
		expect(diff.status).toBe(1)
		expect(diff.stdout).toContain('modified  src/ui/ds/Button.vue (button)')
		const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
		for (const usage of ['components list [--workspace <dir>]', 'components add <name...> --to <dir>', 'components diff [--project <dir>]'])
			expect(help.stdout).toContain(usage)
		expect(help.stdout).toContain('still refuses a move')
	})

	// Rule 01a11be8-5931-…: naming the recorded dependents moves them with the forced move.
	it('moves a recorded dependent too when the forced command names it', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'order-summary-card', '--to', 'src/ui'])).code).toBe(0)
		const result = await run(fixture, ['add', 'button', 'order-summary-card', '--to', 'src/elsewhere', '--force'])
		expect(result.code, result.stderr).toBe(0)
		const record = await readRecord(fixture.project)
		expect([record.components.button.target, record.components['order-summary-card'].target]).toEqual(['src/elsewhere', 'src/elsewhere'])
		// Clause 01a11bb1-8b0c-…: the component digest keys files by source path, whatever the target.
		expect(record.components.button.componentDigest).toBe(await componentDigest({ 'src/ds/Button.vue': sha256(BUTTON) }))
		expect(Object.keys(await snapshot(fixture.project)).filter(path => path.endsWith('.vue')).sort()).toEqual(['src/elsewhere/ds/Button.vue', 'src/elsewhere/product/OrderSummaryCard.vue'])
	})

	// Finding: a copy record edited in the product project must not steer add into the Workspace or .git.
	it('refuses a tampered copy record whose paths reach the Workspace, .git or outside the project, before writing anything', async () => {
		const fixture = await makeFixture()
		// The product project contains the Workspace, as when both live in one repository.
		const project = fixture.base
		const runIn = (argv: string[]) => run(fixture, [...argv, '--project', '.'], project)
		expect((await runIn(['add', 'button', '--to', 'src/ui'])).code).toBe(0)
		const original = await readRecord(project)
		const tamper = async (target: string) => {
			const record = structuredClone(original)
			record.components.button.target = target
			record.components.button.files = { [`${target}/ds/Button.vue`]: original.components.button.files['src/ui/ds/Button.vue'] }
			await writeFile(join(project, 'uiux-components.json'), `${JSON.stringify(record, null, 2)}\n`)
		}
		for (const [target, message] of [
			['workspace/kit', 'lies inside the Workspace'],
			['workspace/KIT', 'lies inside the Workspace'],
			['.git', 'lies in a .git directory'],
			['vendor/.Git', 'lies in a .git directory'],
		] as const) {
			await writeKitFile(project, `${target}/ds/Button.vue`, BUTTON)
			await tamper(target)
			const before = await snapshot(project)
			const result = await runIn(['add', 'order-summary-card', '--to', 'src/ui', '--force'])
			expect(result.code, target).toBe(1)
			expect(result.stderr).toContain(`records ${target} for button, which ${message}`)
			expect(result.stderr).toContain('Nothing was written.')
			expect(await snapshot(project), target).toEqual(before)
			expect((await runIn(['diff'])).code).toBe(1)
		}
		await tamper('../outside')
		const outside = await runIn(['add', 'order-summary-card', '--to', 'src/ui', '--force'])
		expect(outside.code).toBe(1)
		expect(outside.stderr).toContain('uiux-components.json in')
		expect(outside.stderr).toContain('is invalid')
		expect(await lstat(join(fixture.base, '..', 'outside')).catch(() => undefined)).toBeUndefined()
		expect(await readFile(join(fixture.kit, 'src/ds/Button.vue'), 'utf8')).toBe(BUTTON)

		const git = await runIn(['add', 'badge', '--to', '.git/hooks'])
		expect(git.code).toBe(2)
		expect(git.stderr).toContain('lies in a .git directory')
	})

	it('removes only recorded files whose source the registry still declares for the component', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'button', '--to', 'src/ui'])).code).toBe(0)
		const record = await readRecord(fixture.project)
		record.components.button.files['src/ui/ds/Other.vue'] = { source: 'src/ds/Other.vue', digest: sha256('other\n') }
		await writeFile(join(fixture.project, 'uiux-components.json'), JSON.stringify(record))
		await writeFile(join(fixture.project, 'src/ui/ds/Other.vue'), 'other\n')
		const result = await run(fixture, ['add', 'button', '--to', 'src/moved', '--force'])
		expect(result.code, result.stderr).toBe(0)
		expect(result.stdout).toContain('Left src/ui/ds/Other.vue in place: button no longer declares kit/src/ds/Other.vue')
		expect(await readFile(join(fixture.project, 'src/ui/ds/Other.vue'), 'utf8')).toBe('other\n')
		expect(await lstat(join(fixture.project, 'src/ui/ds/Button.vue')).catch(() => undefined)).toBeUndefined()
		expect(Object.keys((await readRecord(fixture.project)).components.button.files)).toEqual(['src/moved/ds/Button.vue'])
	})

	// Issue #206: a write that fails after its file was truncated (a full disk) leaves no partly
	// written file behind, so the same command, run again without --force, finishes the copy.
	it('removes a file a failed write left partly written, so running the same command again converges', async () => {
		const fixture = await makeFixture()
		const probe = await open(join(fixture.base, 'probe'), 'w')
		const prototype = Object.getPrototypeOf(probe) as { writeFile: (this: FileHandle, data: Uint8Array) => Promise<void> }
		await probe.close()
		const original = prototype.writeFile
		/** Fails the `failing`-th write after writing ten bytes of it, as a disk filling up would. */
		const failWrite = async (failing: number, argv: string[]) => {
			let calls = 0
			const spy = vi.spyOn(prototype, 'writeFile').mockImplementation(async function (this: FileHandle, data: Uint8Array) {
				if (++calls !== failing) return original.call(this, data)
				await original.call(this, data.subarray(0, 10))
				throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
			})
			try {
				return await run(fixture, argv)
			}
			finally {
				spy.mockRestore()
			}
		}

		// A new copy: the first file is written, the second fails partway and is removed again.
		const failed = await failWrite(2, ['add', 'order-summary-card', '--to', 'src/ui'])
		expect(failed.code).toBe(1)
		expect(failed.stderr).toContain('Copying stopped: ENOSPC: no space left on device, write')
		expect(failed.stderr).toContain('Written: src/ui/ds/Button.vue.')
		expect(failed.stderr).toContain('src/ui/product/OrderSummaryCard.vue was only partly written and was removed again.')
		expect(await lstat(join(fixture.project, 'src/ui/product/OrderSummaryCard.vue')).catch(() => undefined)).toBeUndefined()
		expect(await lstat(join(fixture.project, 'uiux-components.json')).catch(() => undefined)).toBeUndefined()
		const rerun = await run(fixture, ['add', 'order-summary-card', '--to', 'src/ui'])
		expect(rerun.code, rerun.stderr).toBe(0)
		expect(await readFile(join(fixture.project, 'src/ui/product/OrderSummaryCard.vue'), 'utf8')).toBe(CARD)

		// An update of a recorded copy: the truncated copy is removed, and the rerun writes it whole.
		await writeKitFile(fixture.kit, 'src/ds/Button.vue', `${BUTTON}<!-- v2 -->\n`)
		const before = await readFile(join(fixture.project, 'uiux-components.json'), 'utf8')
		const update = await failWrite(1, ['add', 'button', '--to', 'src/ui'])
		expect(update.code).toBe(1)
		expect(update.stderr).toContain('src/ui/ds/Button.vue was only partly written and was removed again.')
		expect(await lstat(join(fixture.project, 'src/ui/ds/Button.vue')).catch(() => undefined)).toBeUndefined()
		expect(await readFile(join(fixture.project, 'uiux-components.json'), 'utf8')).toBe(before)
		const again = await run(fixture, ['add', 'button', '--to', 'src/ui'])
		expect(again.code, again.stderr).toBe(0)
		expect(await readFile(join(fixture.project, 'src/ui/ds/Button.vue'), 'utf8')).toBe(`${BUTTON}<!-- v2 -->\n`)
		expect((await run(fixture, ['diff', '--check'])).code).toBe(0)
	})

	// Finding: on a case-insensitive file system two spellings of one path are one file.
	it('refuses a write and a removal or a file left in place that differ only in letter case, losing nothing', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'button', '--to', 'src/ui'])).code).toBe(0)
		const before = await snapshot(fixture.project)
		const recased = await run(fixture, ['add', 'button', '--to', 'src/UI', '--force'])
		expect(recased.code).toBe(1)
		expect(recased.stderr).toContain('src/UI/ds/Button.vue and src/ui/ds/Button.vue differ only in letter case')
		expect(await snapshot(fixture.project)).toEqual(before)

		// An upstream rename that changes only the letter case of a file.
		await rm(join(fixture.kit, 'src/ds/Button.vue'))
		await writeKitFile(fixture.kit, 'src/ds/button.vue', BUTTON)
		await setRegistry(fixture.workspace, { ...REGISTRY, button: { ...REGISTRY.button!, files: ['src/ds/button.vue'] } })
		const renamed = await run(fixture, ['add', 'button', '--to', 'src/ui', '--force'])
		expect(renamed.code).toBe(1)
		expect(renamed.stderr).toContain('src/ui/ds/button.vue and src/ui/ds/Button.vue differ only in letter case')
		expect(await snapshot(fixture.project)).toEqual(before)
		expect(await readFile(join(fixture.project, 'src/ui/ds/Button.vue'), 'utf8')).toBe(BUTTON)
	})

	// Finding: `Foſ.vue` and `Fos.vue` are one file on APFS, whose fold maps the long s to s.
	it('refuses a component whose copy differs from another recorded copy only by a fold beyond lower case', async () => {
		const fixture = await makeFixture({
			alpha: { files: ['src/a/Foſ.vue'], layer: 'design-system' },
			beta: { files: ['src/a/Fos.vue'], layer: 'design-system' },
		})
		await writeKitFile(fixture.kit, 'src/a/Foſ.vue', BADGE)
		await writeKitFile(fixture.kit, 'src/a/Fos.vue', BADGE)
		expect((await run(fixture, ['add', 'alpha', '--to', 'x'])).code).toBe(0)
		const before = await snapshot(fixture.project)
		const second = await run(fixture, ['add', 'beta', '--to', 'x'])
		expect(second.code).toBe(1)
		expect(second.stderr).toContain('x/a/Fos.vue and x/a/Foſ.vue differ only in letter case')
		expect(await snapshot(fixture.project)).toEqual(before)
		expect(Object.keys((await readRecord(fixture.project)).components)).toEqual(['alpha'])
	})

	// Finding: a failure part-way reports what was written, leaves the record alone, and a rerun converges.
	it.skipIf(process.getuid?.() === 0)('reports a failed write with what was written, keeps the record, and finishes on a rerun', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'button', '--to', 'src/ui'])).code).toBe(0)
		const record = await readFile(join(fixture.project, 'uiux-components.json'), 'utf8')
		const product = join(fixture.project, 'src/ui/product')
		await mkdir(product)
		await chmod(product, 0o555)
		try {
			const failed = await run(fixture, ['add', 'order-summary-card', 'badge', '--to', 'src/ui'])
			expect(failed.code).toBe(1)
			expect(failed.stderr).toContain('uiux: Copying stopped:')
			expect(failed.stderr).toContain('uiux: Written: src/ui/ds/Badge.vue.')
			expect(failed.stderr).toContain('uiux-components.json was not changed')
			expect(await readFile(join(fixture.project, 'uiux-components.json'), 'utf8')).toBe(record)
		}
		finally {
			await chmod(product, 0o755)
		}
		const rerun = await run(fixture, ['add', 'order-summary-card', 'badge', '--to', 'src/ui'])
		expect(rerun.code, rerun.stderr).toBe(0)
		expect(rerun.stdout).toContain('(1 file written, 2 unchanged)')
		expect(Object.keys((await readRecord(fixture.project)).components).sort()).toEqual(['badge', 'button', 'order-summary-card'])
	})

	it('refuses --to with a backslash', async () => {
		const fixture = await makeFixture()
		const result = await run(fixture, ['add', 'badge', '--to', 'src\\ui'])
		expect(result.code).toBe(2)
		expect(result.stderr).toContain('contains a backslash')
		expect(Object.keys(await snapshot(fixture.project))).toEqual(['package.json'])
	})

	it('refuses diff, naming the link, when a copy was replaced by a symbolic link, and prints no partial report', async () => {
		const fixture = await makeFixture()
		expect((await run(fixture, ['add', 'button', 'badge', '--to', 'src/ui'])).code).toBe(0)
		const elsewhere = join(fixture.base, 'Button.vue')
		await writeFile(elsewhere, BUTTON)
		await rm(join(fixture.project, 'src/ui/ds/Button.vue'))
		await symlink(elsewhere, join(fixture.project, 'src/ui/ds/Button.vue'))
		const result = await run(fixture, ['diff'])
		expect(result.code).toBe(1)
		expect(result.stderr).toContain('src/ui/ds/Button.vue in the product project is a symbolic link')
		expect(result.stdout).toBe('')
	})
})
