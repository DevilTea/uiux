import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { locateKitProject } from '../src/adapters/kit-registry'
import { isKitFilePath, listKitFiles, MAX_KIT_FILE_BYTES, MAX_KIT_FILE_ENTRIES, readKitFile } from '../src/adapters/kit-source-files'
import type { MemberPrincipal } from '../src/application/access/principal'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { runComponentsCommand } from '../src/cli/components'
import { runInitCommand } from '../src/cli/init'
import { hasGitSegment } from '../src/domain/product-kit/copy-record'
import { emptyProductKit, type ProductKit } from '../src/domain/product-kit/schema'
import { segmentNamesInAnyCase } from '../src/domain/validation'
import { kitFileResourceUri } from '../src/mcp/resource-uri'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { compareComponentCopiesForHttp, getComponentSourceForHttp, listKitFilesForHttp, readKitFileForHttp } from '../src/server/kit-source-http'
import { connectMcp, scoped, testMember } from './support/access'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

/**
 * The read-only kit source Tools and Resources (issue #141, unit K10): `list_kit_files` (Clause
 * 01a11bb1-b1c2-…), `uiux://product-kit/file/{path}` (Clauses 01a11bb1-b0f1-… and 01a11485-f70a-…),
 * `get_component_source` (Clause 01a11bb1-b227-…), `compare_component_copies` (Clause 01a11bb1-b28f-…),
 * their Workbench mirrors, and `product-kit.source.read` (Clause 01a11485-fa00-…), on a current-schema
 * Workspace: containment in kit/ (no link, `..`, absolute path or kit/node_modules/), no host path in
 * any result or error, and digests equal to those `uiux components add` records.
 */

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const BUTTON = '<script setup lang="ts">\ndefineProps<{ label: string }>()\n</script>\n<template><button>{{ label }}</button></template>\n'
const CARD = '<script setup lang="ts">\nimport Button from \'../ds/Button.vue\'\n</script>\n<template><section><Button label="Pay" /></section></template>\n'
const LOGO = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFE, 0x00, 0x01])

const REGISTRY: ProductKit['components'] = {
	'button': { files: ['src/ds/Button.vue'], packages: ['vue'], layer: 'design-system' },
	'order-summary-card': { files: ['src/product/OrderSummaryCard.vue', 'src/product/logo.png'], requires: ['button'], packages: ['vue', '@acme/money'], layer: 'product' },
}

const AGENT = testMember({ nickname: 'claude', kind: 'agent', preset: 'editor', credential: 'token' })
const NO_SOURCE_AGENT = testMember({ nickname: 'reader', kind: 'agent', credential: 'token', keys: ['workspace.read', 'history.read'] })
const NO_SOURCE_HUMAN = testMember({ nickname: 'nora', kind: 'human', credential: 'session', keys: ['workspace.read'] })
const SOURCE_HUMAN = testMember({ nickname: 'vera', kind: 'human', credential: 'session', keys: ['workspace.read', 'product-kit.source.read'] })

async function write(path: string, content: string | Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, content)
}

/**
 * A current-schema Workspace from `uiux init` whose kit holds the registry above, a build output, an
 * installed dependency, a link to a file outside the Workspace and a linked directory; a product
 * project beside it.
 */
async function fixture(components: ProductKit['components'] = REGISTRY) {
	const base = await realpath(await mkdtemp(join(tmpdir(), 'uiux-kit-source-')))
	roots.push(base)
	const workspace = join(base, 'workspace')
	expect(await runInitCommand({ workspace, env: { UIUX_HOME: join(base, 'home') }, stdout: () => {}, stderr: () => {} })).toBe(0)
	const kit = join(workspace, 'kit')
	await write(join(kit, 'package.json'), JSON.stringify({ name: 'kit', private: true, dependencies: { 'vue': '^3.5.0', '@acme/money': '~2.1.0' } }))
	await write(join(kit, 'src', 'ds', 'Button.vue'), BUTTON)
	await write(join(kit, 'src', 'product', 'OrderSummaryCard.vue'), CARD)
	await write(join(kit, 'src', 'product', 'logo.png'), LOGO)
	await write(join(kit, 'dist', 'uiux.js'), 'export const adapter = {}\n')
	await write(join(kit, 'node_modules', 'vue', 'package.json'), '{ "name": "vue", "version": "3.5.1" }\n')
	await write(join(base, 'secret', 'secret.vue'), 'SECRET\n')
	await symlink(join(base, 'secret', 'secret.vue'), join(kit, 'src', 'linked.vue'))
	await symlink(join(base, 'secret'), join(kit, 'src', 'linked-dir'))
	await writeFile(join(workspace, 'product-kit.json'), `${JSON.stringify({ ...emptyProductKit(), components }, null, 2)}\n`)
	const project = join(base, 'product')
	await write(join(project, 'package.json'), '{ "name": "product" }\n')
	const app = createWorkspaceApplicationSession(new FileNativePersistence({ root: workspace, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }))
	return { base, workspace, kit, project, app }
}

type ToolResult = Readonly<{ isError?: boolean; structuredContent?: Record<string, unknown> }>

async function withMcp<T>(app: ReturnType<typeof createWorkspaceApplicationSession>, principal: MemberPrincipal, run: (call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>, read: (uri: string) => Promise<unknown>) => Promise<T>): Promise<T> {
	const mcp = await connectMcp(app, principal)
	try {
		return await run(
			async (name, args = {}) => await mcp.client.callTool({ name, arguments: args }) as ToolResult,
			async uri => mcp.client.readResource({ uri }),
		)
	}
	finally {
		await mcp.close()
	}
}

async function addComponents(project: string, workspace: string, argv: string[]): Promise<void> {
	const errors: string[] = []
	const code = await runComponentsCommand({
		argv: ['add', ...argv, '--workspace', workspace],
		cwd: project,
		stdout: () => {},
		stderr: line => errors.push(line),
		now: () => new Date('2026-10-14T08:00:00.000Z'),
		gitToplevel: () => undefined,
	})
	expect(code, errors.join('\n')).toBe(0)
}

describe('the kit source Tools and Resources over MCP', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('lists the kit files without kit/node_modules/ or links, each with its Resource URI', async () => {
		const ctx = await fixture()
		await withMcp(ctx.app, AGENT, async (call) => {
			const listed = await call('list_kit_files')
			expect(listed.isError).toBeFalsy()
			const files = (listed.structuredContent as { files: Array<{ path: string; size: number; resourceUri: string }> }).files
			expect(files.map(file => file.path)).toEqual(['dist/uiux.js', 'package.json', 'src/ds/Button.vue', 'src/product/OrderSummaryCard.vue', 'src/product/logo.png'])
			expect(files.find(file => file.path === 'src/ds/Button.vue')).toEqual({ path: 'src/ds/Button.vue', size: Buffer.byteLength(BUTTON), resourceUri: 'uiux://product-kit/file/src%2Fds%2FButton.vue' })
			expect(JSON.stringify(listed)).not.toContain(ctx.base)
		})
	})

	it('reads a kit file from the Resource template as text, or as a base64 blob when it is not UTF-8', async () => {
		const ctx = await fixture()
		await withMcp(ctx.app, AGENT, async (_call, read) => {
			expect(await read(kitFileResourceUri('src/ds/Button.vue'))).toMatchObject({ contents: [{ uri: 'uiux://product-kit/file/src%2Fds%2FButton.vue', mimeType: 'text/plain', text: BUTTON }] })
			expect(await read(kitFileResourceUri('dist/uiux.js'))).toMatchObject({ contents: [{ text: 'export const adapter = {}\n' }] })
			expect(await read(kitFileResourceUri('src/product/logo.png'))).toMatchObject({ contents: [{ mimeType: 'application/octet-stream', blob: Buffer.from(LOGO).toString('base64') }] })
		})
	})

	it('refuses a path outside kit/ on the Resource template, never naming a host path', async () => {
		const ctx = await fixture()
		await withMcp(ctx.app, AGENT, async (_call, read) => {
			const refused = [
				'uiux://product-kit/file/..%2Fworkspace.json', // ../
				'uiux://product-kit/file/%2e%2e%2Fworkspace.json', // encoded ..
				'uiux://product-kit/file/%2E%2E%2F%2E%2E%2Fsecret%2Fsecret.vue',
				'uiux://product-kit/file/src%2F..%2F..%2Fworkspace.json',
				`uiux://product-kit/file/${encodeURIComponent(join(ctx.base, 'secret', 'secret.vue'))}`, // absolute
				'uiux://product-kit/file/%2Fetc%2Fpasswd',
				'uiux://product-kit/file/src%5Cds%5CButton.vue', // backslash
				'uiux://product-kit/file/node_modules%2Fvue%2Fpackage.json',
				'uiux://product-kit/file/NODE_MODULES%2Fvue%2Fpackage.json',
				'uiux://product-kit/file/src%2Flinked.vue', // a link to a file outside
				'uiux://product-kit/file/src%2Flinked-dir%2Fsecret.vue', // below a linked directory
				'uiux://product-kit/file/src%2Fds', // a directory
				'uiux://product-kit/file/src%2Fmissing.vue',
				'uiux://product-kit/file/src/ds/Button.vue', // unencoded slashes match no template
				'uiux://product-kit/file/../workspace.json',
				'uiux://product-kit/file/%E0%A4%A',
			]
			for (const uri of refused) {
				const error = await read(uri).then(() => undefined, (caught: unknown) => caught)
				expect(error, uri).toBeInstanceOf(Error)
				expect(String((error as Error).message), uri).not.toContain(ctx.base)
				expect(JSON.stringify(error), uri).not.toContain('SECRET')
			}
		})
	})

	it('returns a component and its requires with digests equal to those uiux components add records', async () => {
		const ctx = await fixture()
		await addComponents(ctx.project, ctx.workspace, ['order-summary-card', '--to', 'src/components'])
		const record = JSON.parse(await readFile(join(ctx.project, 'uiux-components.json'), 'utf8')) as { components: Record<string, { target: string; componentDigest: string; exportedAt: string; files: Record<string, { source: string; digest: string }> }> }
		await withMcp(ctx.app, AGENT, async (call) => {
			const single = await call('get_component_source', { name: 'order-summary-card' })
			expect(single.isError).toBeFalsy()
			expect((single.structuredContent as { components: Array<{ name: string }> }).components.map(component => component.name)).toEqual(['order-summary-card'])

			const result = await call('get_component_source', { name: 'order-summary-card', withRequires: true })
			expect(result.isError).toBeFalsy()
			const components = (result.structuredContent as { components: Array<{ name: string; componentDigest: string; requires: string[]; packages: Record<string, string | null>; files: Array<{ path: string; digest: string; content: string; encoding?: string }>; copyRecordEntry: { componentDigest: string; exportedAt: string; files: Record<string, { source: string; digest: string }> } }> }).components
			expect(components.map(component => component.name)).toEqual(['order-summary-card', 'button'])
			const [card, button] = components
			expect(card!.requires).toEqual(['button'])
			expect(card!.packages).toEqual({ 'vue': '^3.5.0', '@acme/money': '~2.1.0' })
			expect(card!.files).toEqual([
				{ path: 'src/product/OrderSummaryCard.vue', digest: record.components['order-summary-card']!.files['src/components/product/OrderSummaryCard.vue']!.digest, content: CARD },
				{ path: 'src/product/logo.png', digest: record.components['order-summary-card']!.files['src/components/product/logo.png']!.digest, content: Buffer.from(LOGO).toString('base64'), encoding: 'base64' },
			])
			expect(button!.files[0]!.content).toBe(BUTTON)
			// The entry an Agent writes, with target added and each files key below it, is the CLI's.
			for (const component of components) {
				const recorded = record.components[component.name]!
				expect(component.componentDigest).toBe(recorded.componentDigest)
				const entry = component.copyRecordEntry
				expect(entry.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
				expect({ target: 'src/components', componentDigest: entry.componentDigest, exportedAt: recorded.exportedAt, files: Object.fromEntries(Object.entries(entry.files).map(([path, file]) => [`src/components/${path}`, file])) }).toEqual(recorded)
			}
			expect(JSON.stringify(result)).not.toContain(ctx.base)
		})
	})

	it('refuses an unknown component, and a declared file that is a link, without naming a host path', async () => {
		const ctx = await fixture({ ...REGISTRY, linked: { files: ['src/linked.vue'], layer: 'product' } })
		await withMcp(ctx.app, AGENT, async (call) => {
			const unknown = await call('get_component_source', { name: 'no-such-card' })
			expect(unknown.isError).toBe(true)
			expect(unknown.structuredContent).toMatchObject({ status: 'not_found', key: 'product-kit', components: ['no-such-card'] })
			const linked = await call('get_component_source', { name: 'linked' })
			expect(linked.isError).toBe(true)
			expect(linked.structuredContent).toMatchObject({ status: 'invalid', code: 'kit.component_invalid' })
			expect(JSON.stringify(linked)).not.toContain(ctx.base)
			expect(JSON.stringify(linked)).not.toContain('SECRET')
		})
	})

	it('returns the Workspace side of drift for recorded copies', async () => {
		const ctx = await fixture()
		await addComponents(ctx.project, ctx.workspace, ['order-summary-card', '--to', 'src/components'])
		const record = JSON.parse(await readFile(join(ctx.project, 'uiux-components.json'), 'utf8')) as { components: Record<string, unknown> }
		await writeFile(join(ctx.kit, 'src', 'ds', 'Button.vue'), `${BUTTON}<!-- changed -->\n`)
		const digest = `sha256:${'0'.repeat(64)}`
		const copies = {
			...record.components,
			'gone': { files: { 'src/components/Gone.vue': { source: 'src/Gone.vue', digest } } },
			'button-escape': { files: { 'src/x.vue': { source: '../../secret/secret.vue', digest } } },
		}
		await withMcp(ctx.app, AGENT, async (call) => {
			const compared = await call('compare_component_copies', { copies })
			expect(compared.isError).toBeFalsy()
			const files = (compared.structuredContent as { files: Array<Record<string, unknown>> }).files
			expect(files.map(file => [file.component, file.path, file.original])).toEqual([
				['button', 'src/components/ds/Button.vue', 'differs'],
				['button-escape', 'src/x.vue', 'removed'],
				['gone', 'src/components/Gone.vue', 'removed'],
				['order-summary-card', 'src/components/product/OrderSummaryCard.vue', 'matches'],
				['order-summary-card', 'src/components/product/logo.png', 'matches'],
			])
			expect(files[0]!.originalDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
			expect(files[0]!.originalDigest).not.toBe(files[0]!.recordedDigest)
		})
		// A recorded source the component does not declare (here one leaving kit/) differs; it is never read.
		const escaping = { button: { files: { 'src/x.vue': { source: '../../secret/secret.vue', digest } } } }
		await withMcp(ctx.app, AGENT, async (call) => {
			const compared = await call('compare_component_copies', { copies: escaping })
			expect((compared.structuredContent as { files: unknown[] }).files).toEqual([{ component: 'button', path: 'src/x.vue', source: '../../secret/secret.vue', recordedDigest: digest, original: 'differs', originalDigest: null }])
		})
	})

	it('refuses every kit source Tool and the file Resource without product-kit.source.read', async () => {
		const ctx = await fixture()
		await withMcp(ctx.app, NO_SOURCE_AGENT, async (call, read) => {
			for (const [name, args] of [['list_kit_files', {}], ['get_component_source', { name: 'button' }], ['compare_component_copies', { copies: {} }]] as const) {
				const refused = await call(name, args)
				expect(refused.isError, name).toBe(true)
				expect(refused.structuredContent, name).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['product-kit.source.read'] })
			}
			await expect(read(kitFileResourceUri('src/ds/Button.vue'))).rejects.toThrow(/auth\.scope_denied/u)
			// workspace.read still reads the Product Kit Resource.
			await expect(read('uiux://product-kit')).resolves.toBeDefined()
		})
	})
})

describe('the kit source Workbench mirrors (HTTP)', () => {
	it('serve the same results with product-kit.source.read and refuse without it', async () => {
		const ctx = await fixture()
		const allowed = scoped(ctx.app, SOURCE_HUMAN)
		const listed = await listKitFilesForHttp(allowed)
		expect(listed.status).toBe(200)
		expect((listed.body as { files: Array<{ path: string }> }).files.map(file => file.path)).toContain('src/ds/Button.vue')
		const file = await readKitFileForHttp(allowed, 'src/ds/Button.vue')
		expect(file).toMatchObject({ status: 200, body: { status: 'found', path: 'src/ds/Button.vue', content: BUTTON } })
		expect((file.body as Record<string, unknown>).bytes).toBeUndefined()
		expect((await readKitFileForHttp(allowed, 'src/product/logo.png')).body).toMatchObject({ encoding: 'base64', content: Buffer.from(LOGO).toString('base64') })
		expect((await readKitFileForHttp(allowed, '../workspace.json')).status).toBe(400)
		expect((await readKitFileForHttp(allowed, join(ctx.base, 'secret', 'secret.vue'))).status).toBe(400)
		expect((await readKitFileForHttp(allowed, 'node_modules/vue/package.json')).status).toBe(400)
		expect((await readKitFileForHttp(allowed, ['a', 'b'])).status).toBe(400)
		const linked = await readKitFileForHttp(allowed, 'src/linked.vue')
		expect(linked.status).toBe(404)
		expect(JSON.stringify(linked.body)).not.toContain(ctx.base)
		expect(await getComponentSourceForHttp(allowed, { name: 'button' })).toMatchObject({ status: 200, body: { status: 'found' } })
		expect((await getComponentSourceForHttp(allowed, { name: 'nope' })).status).toBe(404)
		expect((await getComponentSourceForHttp(allowed, { name: 1 })).status).toBe(400)
		expect(await compareComponentCopiesForHttp(allowed, { copies: {} })).toMatchObject({ status: 200, body: { status: 'compared', files: [] } })

		const denied = scoped(ctx.app, NO_SOURCE_HUMAN)
		for (const result of [
			await listKitFilesForHttp(denied),
			await readKitFileForHttp(denied, 'src/ds/Button.vue'),
			await readKitFileForHttp(denied, '../workspace.json'),
			await getComponentSourceForHttp(denied, { name: 'button' }),
			await getComponentSourceForHttp(denied, undefined),
			await compareComponentCopiesForHttp(denied, { copies: {} }),
		]) expect(result).toMatchObject({ status: 403, body: { code: 'auth.scope_denied', requiredKeys: ['product-kit.source.read'] } })
	})
})

/** `mkfifo` where the host has it (macOS and Linux); `false` elsewhere, which skips the FIFO checks. */
function makeFifo(path: string): boolean {
	try {
		execFileSync('mkfifo', [path], { stdio: 'ignore' })
		return true
	}
	catch {
		return false
	}
}

/** Fails when `promise` takes longer than `ms`: a read that blocks on a FIFO would. */
async function promptly<T>(promise: Promise<T>, ms = 2000): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms)
		})])
	}
	finally {
		clearTimeout(timer)
	}
}

// Rule 01a13d3e-e253-76b7-84e5-5f3fb167b635 and Clause 01a13d3e-c4b5-7cc3-a36b-3be6f45cf7ac.
describe('kit file reads stay inside kit/ and within their limits', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('reads nothing through a symbolic link standing in for kit/ or kit/src/', async () => {
		const ctx = await fixture()
		const allowed = scoped(ctx.app, SOURCE_HUMAN)
		const outside = join(ctx.base, 'outside-kit')
		await rename(ctx.kit, outside)
		await symlink(outside, ctx.kit)
		expect((await listKitFilesForHttp(allowed)).body).toMatchObject({ status: 'listed', files: [], truncated: false })
		expect((await readKitFileForHttp(allowed, 'src/ds/Button.vue')).status).toBe(404)

		await rm(ctx.kit)
		await rename(outside, ctx.kit)
		await rename(join(ctx.kit, 'src'), join(ctx.base, 'outside-src'))
		await symlink(join(ctx.base, 'outside-src'), join(ctx.kit, 'src'))
		const listed = (await listKitFilesForHttp(allowed)).body as { files: Array<{ path: string }> }
		expect(listed.files.map(file => file.path)).toEqual(['dist/uiux.js', 'package.json'])
		expect((await readKitFileForHttp(allowed, 'src/ds/Button.vue')).status).toBe(404)
		const source = await getComponentSourceForHttp(allowed, { name: 'button' })
		expect(source.body).toMatchObject({ status: 'invalid', code: 'kit.component_invalid' })
		expect(JSON.stringify(source.body)).not.toContain(ctx.base)
	})

	it('refuses a FIFO promptly, never blocking on it', async () => {
		const ctx = await fixture()
		const fifo = join(ctx.kit, 'src', 'pipe.vue')
		if (!makeFifo(fifo)) return
		const allowed = scoped(ctx.app, SOURCE_HUMAN)
		expect((await promptly(readKitFileForHttp(allowed, 'src/pipe.vue'))).status).toBe(404)
		const listed = (await promptly(listKitFilesForHttp(allowed))).body as { files: Array<{ path: string }> }
		expect(listed.files.map(file => file.path)).not.toContain('src/pipe.vue')
		// A FIFO swapped in after the path checks is opened without blocking and refused on the open file.
		const kit = await locateKitProject(ctx.workspace, 'kit')
		const button = join(ctx.kit, 'src', 'ds', 'Button.vue')
		const swapped = await promptly(readKitFile(kit, 'src/ds/Button.vue', {
			beforeOpen: async () => {
				await rm(button)
				expect(makeFifo(button)).toBe(true)
			},
		}))
		expect(swapped).toEqual({ status: 'not_found' })
	})

	it('refuses a path with a NUL or another control character', async () => {
		const ctx = await fixture()
		const allowed = scoped(ctx.app, SOURCE_HUMAN)
		for (const path of ['src/ds/Button.vue\u0000', 'src\u0000/ds/Button.vue', 'src/ds/Button.vue\u0000.png', 'src/\u0007.vue'])
			expect((await readKitFileForHttp(allowed, path)).status, JSON.stringify(path)).toBe(400)
		await withMcp(ctx.app, AGENT, async (_call, read) => {
			await expect(read('uiux://product-kit/file/src%2Fds%2FButton.vue%00')).rejects.toThrow(/Invalid kit file path/u)
		})
	})

	it('treats every spelling a case-insensitive file system folds to node_modules as kit/node_modules/', async () => {
		const ctx = await fixture()
		const allowed = scoped(ctx.app, SOURCE_HUMAN)
		for (const spelling of ['NODE_MODULES', 'Node_Modules', 'node_moduleſ', 'NODE_MODULEſ', 'nodE_moduleS']) {
			expect(isKitFilePath(`${spelling}/vue/package.json`), spelling).toBe(false)
			expect((await readKitFileForHttp(allowed, `${spelling}/vue/package.json`)).status, spelling).toBe(400)
		}
		// .git in the product project (`uiux components`), by the same fold.
		expect(hasGitSegment('src/.GIT/config')).toBe(true)
		expect(hasGitSegment('src/.Git')).toBe(true)
		expect(hasGitSegment('src/.gitignore')).toBe(false)
		expect(segmentNamesInAnyCase('node_moduleſ', 'node_modules')).toBe(true)
		expect(segmentNamesInAnyCase('node_module', 'node_modules')).toBe(false)
	})

	it('refuses a kit file above 8 MiB with kit.file_too_large on every read, and reads one of exactly 8 MiB', async () => {
		const ctx = await fixture({ ...REGISTRY, big: { files: ['src/big.bin'], layer: 'product' } })
		await write(join(ctx.kit, 'src', 'big.bin'), new Uint8Array(MAX_KIT_FILE_BYTES + 1))
		await write(join(ctx.kit, 'src', 'edge.bin'), new Uint8Array(MAX_KIT_FILE_BYTES))
		const allowed = scoped(ctx.app, SOURCE_HUMAN)
		const refused = { status: 'too_large', code: 'kit.file_too_large', path: 'src/big.bin', limit: MAX_KIT_FILE_BYTES }
		expect(await readKitFileForHttp(allowed, 'src/big.bin')).toMatchObject({ status: 422, body: refused })
		expect(await readKitFileForHttp(allowed, 'src/edge.bin')).toMatchObject({ status: 200, body: { status: 'found', size: MAX_KIT_FILE_BYTES } })
		await withMcp(ctx.app, AGENT, async (call, read) => {
			await expect(read(kitFileResourceUri('src/big.bin'))).rejects.toThrow(/kit\.file_too_large/u)
			const source = await call('get_component_source', { name: 'big' })
			expect(source.isError).toBe(true)
			expect(source.structuredContent).toMatchObject(refused)
			const compared = await call('compare_component_copies', { copies: { big: { files: { 'src/components/big.bin': { source: 'src/big.bin', digest: `sha256:${'0'.repeat(64)}` } } } } })
			expect(compared.isError).toBe(true)
			expect(compared.structuredContent).toMatchObject(refused)
			expect(JSON.stringify(compared)).not.toContain(ctx.base)
		})
		// A file that grew past the limit after its size was checked is refused, never cut short.
		const kit = await locateKitProject(ctx.workspace, 'kit')
		const grown = await readKitFile(kit, 'src/ds/Button.vue', { maxBytes: Buffer.byteLength(BUTTON), afterOpen: () => appendFile(join(ctx.kit, 'src', 'ds', 'Button.vue'), 'more') })
		expect(grown).toEqual({ status: 'too_large', limit: Buffer.byteLength(BUTTON) })
	})

	// One walk of 10,001 files costs about a second alone and several times that on a loaded host, so the
	// two surfaces are separate tests (each with its own timeout budget and one walk) and the boundary is
	// asserted below on a small cap.
	async function fixtureWithMoreThanTheCap() {
		const ctx = await fixture()
		const many = join(ctx.kit, 'many')
		await mkdir(many)
		for (let start = 0; start <= MAX_KIT_FILE_ENTRIES; start += 500)
			await Promise.all(Array.from({ length: Math.min(500, MAX_KIT_FILE_ENTRIES + 1 - start) }, (_, offset) => writeFile(join(many, `f${String(start + offset).padStart(5, '0')}.txt`), '')))
		return ctx
	}

	it('lists at most 10,000 files and marks a cut-off listing truncated', async () => {
		const ctx = await fixtureWithMoreThanTheCap()
		const listed = (await listKitFilesForHttp(scoped(ctx.app, SOURCE_HUMAN))).body as { files: Array<{ path: string }>; truncated: boolean }
		expect(listed.truncated).toBe(true)
		expect(listed.files).toHaveLength(MAX_KIT_FILE_ENTRIES)
		expect(listed.files.map(file => file.path)).toEqual(listed.files.map(file => file.path).sort())
	})

	it('marks a cut-off listing truncated in list_kit_files over MCP', async () => {
		const ctx = await fixtureWithMoreThanTheCap()
		await withMcp(ctx.app, AGENT, async (call) => {
			expect((await call('list_kit_files')).structuredContent).toMatchObject({ status: 'listed', truncated: true })
		})
	})

	// The boundary runs on the same walk with a small cap (`listKitFiles`' `maxEntries`, which the 10,000 default feeds).
	it('keeps a listing of exactly the cap whole and marks one file more truncated', async () => {
		const ctx = await fixture()
		const many = join(ctx.kit, 'many')
		await mkdir(many)
		await Promise.all(Array.from({ length: 20 }, (_, index) => writeFile(join(many, `f${String(index).padStart(2, '0')}.txt`), '')))
		const kit = await locateKitProject(ctx.workspace, 'kit')
		const whole = await listKitFiles(kit)
		expect(whole.truncated).toBe(false)
		const total = whole.files.length
		expect(total).toBeGreaterThan(20)
		const exact = await listKitFiles(kit, total)
		expect(exact.truncated).toBe(false)
		expect(exact.files).toHaveLength(total)
		const cut = await listKitFiles(kit, total - 1)
		expect(cut.truncated).toBe(true)
		expect(cut.files).toHaveLength(total - 1)
	})

	it('refuses, never reads, a file whose directory is swapped for a link between the checks and the open', async () => {
		const ctx = await fixture()
		await write(join(ctx.base, 'decoy', 'ds', 'Button.vue'), 'SECRET\n')
		const kit = await locateKitProject(ctx.workspace, 'kit')
		const source = join(ctx.kit, 'src')
		const moved = join(ctx.kit, 'src-moved')
		let swapped = false
		const swapSource = async () => {
			await rename(source, moved)
			await symlink(join(ctx.base, 'decoy'), source)
			swapped = true
		}
		const restoreSource = async () => {
			if (!swapped) return
			await rm(source)
			await rename(moved, source)
			swapped = false
		}
		const text = (outcome: Awaited<ReturnType<typeof readKitFile>>) => outcome.status === 'found' ? Buffer.from(outcome.bytes).toString() : outcome.status
		// The link still in place when the open file is judged: its real path lies outside kit/ (on
		// darwin the open itself refuses the link).
		expect(await readKitFile(kit, 'src/ds/Button.vue', { beforeOpen: swapSource })).toEqual({ status: 'not_found' })
		await restoreSource()
		// The link swapped back before the open file is judged: the path is inside kit/ again, but the
		// open file is not the one there.
		expect(await readKitFile(kit, 'src/ds/Button.vue', { beforeOpen: swapSource, afterOpen: restoreSource })).toEqual({ status: 'not_found' })
		await restoreSource()
		expect(text(await readKitFile(kit, 'src/ds/Button.vue'))).toBe(BUTTON)
		// The link swapped in after the open file was judged: the bytes come from the open file, never
		// from the path, which now names the decoy.
		expect(text(await readKitFile(kit, 'src/ds/Button.vue', { beforeRead: swapSource }))).toBe(BUTTON)
		await restoreSource()
		expect(text(await readKitFile(kit, 'src/ds/Button.vue', { maxBytes: Number.POSITIVE_INFINITY, beforeRead: swapSource }))).toBe(BUTTON)
		await restoreSource()

		// kit/ itself swapped for a link to a copy outside the Workspace.
		const kitMoved = join(ctx.base, 'kit-moved')
		await write(join(ctx.base, 'kit-copy', 'src', 'ds', 'Button.vue'), 'SECRET\n')
		expect(await readKitFile(kit, 'src/ds/Button.vue', {
			beforeOpen: async () => {
				await rename(ctx.kit, kitMoved)
				await symlink(join(ctx.base, 'kit-copy'), ctx.kit)
			},
		})).toEqual({ status: 'not_found' })
		await rm(ctx.kit)
		await rename(kitMoved, ctx.kit)

		// The file itself swapped for a link: opened without following it.
		const button = join(ctx.kit, 'src', 'ds', 'Button.vue')
		expect(await readKitFile(kit, 'src/ds/Button.vue', {
			beforeOpen: async () => {
				await rm(button)
				await symlink(join(ctx.base, 'secret', 'secret.vue'), button)
			},
		})).toEqual({ status: 'not_found' })
	})
})
