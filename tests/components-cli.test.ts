import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { runComponentsCommand } from '../src/cli/components'
import { runInitCommand } from '../src/cli/init'
import { componentClosure } from '../src/domain/product-kit/closure'
import { driftState, validateCopyRecord } from '../src/domain/product-kit/copy-record'
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
	})
})
