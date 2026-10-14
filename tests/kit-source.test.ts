import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { MemberPrincipal } from '../src/application/access/principal'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { runComponentsCommand } from '../src/cli/components'
import { runInitCommand } from '../src/cli/init'
import { emptyProductKit, type ProductKit } from '../src/domain/product-kit/schema'
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

const AGENT = testMember({ nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })
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
