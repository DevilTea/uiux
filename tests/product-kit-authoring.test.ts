import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager, type LeaseManager } from '../src/application/access/leases'
import { productKitChangeKeys } from '../src/application/access/policy'
import type { MemberPrincipal } from '../src/application/access/principal'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { emptyProductKit, type ProductKit } from '../src/domain/product-kit/schema'
import { canonicalJsonBytes, FileNativePersistence, V5_LAYOUT } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import {
	composeProductKitForHttp,
	readProductKitForHttp,
	updateComponentRegistryForHttp,
	updateProductKitForHttp,
	updateWorkspaceSettingsForHttp,
} from '../src/server/authoring-http'
import { connectMcp, scoped, testMember } from './support/access'
import { currentManifest, V5_TEST_SCHEMA_POLICY, v5Manifest, writeManifest } from './support/workspace-layout'

/**
 * The Product Kit authoring operations (issue #141, unit K5), dormant at `schemaVersion` 5 under the
 * injected `V5_TEST_SCHEMA_POLICY`: Clauses 01a11bb1-b15c-…, 01a11bb1-b35a-…, 01a11bb1-b3c2-…,
 * 01a11bb1-b0f1-…, 01a11bb1-8d03-…, 01a11485-f769-… and 01a11485-f70a-…, Rules 01a11485-efb6-…,
 * 01a11bb1-a120-…, 01a11bb1-a2ac-… and 01a11bb1-a310-….
 */

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const KIT: ProductKit = {
	...emptyProductKit(),
	designSystems: ['@acme/design-system'],
	adapters: [{ moduleSpecifier: './uiux.js', config: { density: 'compact' } }],
}

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, content)
}

/** A v5 Workspace whose kit project declares two packages and holds a plain-module Adapter and three component files. */
async function v5Fixture(kit: ProductKit = KIT) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-product-kit-')))
	roots.push(root)
	await writeManifest(root, canonicalJsonBytes(v5Manifest()), V5_LAYOUT)
	await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes(kit))
	await write(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', private: true, dependencies: { '@acme/design-system': '^1.0.0', '@acme/uiux-adapter': '^2.0.0' } }))
	await write(join(root, 'kit', 'node_modules', '@acme', 'design-system', 'package.json'), JSON.stringify({ name: '@acme/design-system', version: '1.4.2' }))
	await write(join(root, 'kit', 'uiux.js'), 'export const adapter = {}\n')
	await write(join(root, 'kit', 'src', 'button.ts'), 'export const button = 1\n')
	await write(join(root, 'kit', 'src', 'money.ts'), 'export const money = 1\n')
	await write(join(root, 'kit', 'src', 'card.ts'), 'import { money } from \'./money\'\nimport { button } from \'./button.js\'\nexport const card = money + button\n')
	const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY })
	const app = createWorkspaceApplicationSession(persistence)
	return { root, persistence, app, kitPath: join(root, 'product-kit.json') }
}

async function revision(app: WorkspaceApplicationSession): Promise<string> {
	const read = await app.readProductKit()
	if (!read) throw new Error('no Product Kit')
	return read.revision
}

const HUMAN_EDITOR = testMember({ nickname: 'erin', kind: 'human', role: 'editor', credential: 'session' })
const AGENT = testMember({ nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })
const OTHER_AGENT = testMember({ nickname: 'codex', kind: 'agent', role: 'editor', credential: 'token' })
const VIEWER = testMember({ nickname: 'vera', kind: 'human', role: 'viewer', credential: 'session' })
const WRITER = testMember({ nickname: 'wes', kind: 'human', credential: 'session', keys: ['workspace.read', 'product-kit.source.read', 'product-kit.write'] })
const COMPOSER_ONLY = testMember({ nickname: 'cole', kind: 'human', credential: 'session', keys: ['workspace.read', 'product-kit.compose'] })

function http(app: WorkspaceApplicationSession, principal: MemberPrincipal, leases: LeaseManager = createLeaseManager()) {
	return scoped(app, principal, { leases })
}

describe('compose_product_kit, update_product_kit and update_component_registry over HTTP and MCP', () => {
	it('composes designSystems and the Adapter list, keeping a kept Adapter\'s config, over HTTP', async () => {
		const ctx = await v5Fixture()
		const composed = await composeProductKitForHttp(http(ctx.app, HUMAN_EDITOR), {
			expectedRevision: await revision(ctx.app),
			designSystems: ['@acme/design-system'],
			adapters: ['@acme/uiux-adapter/uiux', './uiux.js'],
		})
		expect(composed.status, JSON.stringify(composed.body)).toBe(200)
		expect(composed.body).toMatchObject({ status: 'updated', key: 'product-kit' })
		const stored = JSON.parse(await readFile(ctx.kitPath, 'utf8'))
		expect(stored.adapters).toEqual([{ moduleSpecifier: '@acme/uiux-adapter/uiux' }, { moduleSpecifier: './uiux.js', config: { density: 'compact' } }])
		expect(stored.designSystems).toEqual(['@acme/design-system'])
	})

	it('updates the Adapter config, styles and themes over MCP, and refuses a specifier change there', async () => {
		const ctx = await v5Fixture()
		const mcp = await connectMcp(ctx.app, AGENT)
		try {
			const updated = await mcp.client.callTool({ name: 'update_product_kit', arguments: {
				expectedRevision: await revision(ctx.app),
				adapters: [{ moduleSpecifier: './uiux.js', config: { density: 'comfortable' } }],
				styles: ['./dist/kit.css', '@acme/design-system/styles.css'],
				themes: { dark: { 'data-theme': 'dark' } },
			} })
			expect(updated.isError, JSON.stringify(updated.structuredContent)).not.toBe(true)
			expect(updated.structuredContent).toMatchObject({ status: 'updated', key: 'product-kit', resourceUri: 'uiux://product-kit' })
			const stored = JSON.parse(await readFile(ctx.kitPath, 'utf8'))
			expect(stored).toMatchObject({ adapters: [{ moduleSpecifier: './uiux.js', config: { density: 'comfortable' } }], styles: ['./dist/kit.css', '@acme/design-system/styles.css'], themes: { dark: { 'data-theme': 'dark' } } })

			const bytes = await readFile(ctx.kitPath, 'utf8')
			const repointed = await mcp.client.callTool({ name: 'update_product_kit', arguments: {
				expectedRevision: await revision(ctx.app),
				adapters: [{ moduleSpecifier: '@acme/uiux-adapter' }],
				styles: [],
				themes: {},
			} })
			expect(repointed.isError).toBe(true)
			expect(repointed.structuredContent).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.adapters_not_current' })] })
			expect(await readFile(ctx.kitPath, 'utf8')).toBe(bytes)
		}
		finally { await mcp.close() }
	})

	it('updates the component registry over MCP and HTTP, with import-scan findings that do not refuse', async () => {
		const ctx = await v5Fixture()
		const mcp = await connectMcp(ctx.app, AGENT)
		try {
			const registered = await mcp.client.callTool({ name: 'update_component_registry', arguments: {
				expectedRevision: await revision(ctx.app),
				components: {
					button: { files: ['src/button.ts'], layer: 'design-system', packages: ['@acme/design-system'] },
					// card imports button.js without requiring button, and declares money.ts after its entry.
					card: { files: ['src/card.ts', 'src/money.ts'], layer: 'product' },
				},
				widgets: { Button: { component: 'button' }, DatePicker: { import: '@acme/design-system', export: 'DatePicker' } },
			} })
			expect(registered.isError, JSON.stringify(registered.structuredContent)).not.toBe(true)
			expect(registered.structuredContent).toMatchObject({
				status: 'updated',
				findings: [expect.objectContaining({ code: 'kit.component_invalid', path: '/components/card', message: expect.stringContaining('kit/src/button.ts') })],
			})
		}
		finally { await mcp.close() }

		const fixed = await updateComponentRegistryForHttp(http(ctx.app, HUMAN_EDITOR), {
			expectedRevision: await revision(ctx.app),
			components: {
				button: { files: ['src/button.ts'], layer: 'design-system' },
				card: { files: ['src/card.ts', 'src/money.ts'], requires: ['button'], layer: 'product' },
				lonely: { files: ['src/button.ts', 'src/money.ts'], layer: 'product' },
			},
			widgets: {},
		})
		expect(fixed.status, JSON.stringify(fixed.body)).toBe(200)
		// The second file of `lonely` is imported by nothing in it.
		expect((fixed.body as { findings: unknown[] }).findings).toEqual([expect.objectContaining({ code: 'kit.component_invalid', path: '/components/lonely/files/1' })])
	})

	it('refuses a registry entry that fails validation with kit.component_invalid, storing nothing (Rule 01a11bb1-a2ac)', async () => {
		const ctx = await v5Fixture({ ...KIT, adapters: [{ moduleSpecifier: './src/wrapper.js' }] })
		await write(join(ctx.root, 'kit', 'src', 'wrapper.js'), 'export const adapter = {}\n')
		await write(join(ctx.root, 'outside.ts'), 'export const leak = 1\n')
		await symlink(join(ctx.root, 'outside.ts'), join(ctx.root, 'kit', 'src', 'leak.ts'))
		const bytes = await readFile(ctx.kitPath, 'utf8')
		const session = http(ctx.app, HUMAN_EDITOR)
		const cases: readonly Readonly<[string, Record<string, unknown>, string]>[] = [
			['missing file', { a: { files: ['src/nope.ts'], layer: 'product' } }, '/components/a/files/0'],
			['wrapper entry', { a: { files: ['src/wrapper.js'], layer: 'product' } }, '/components/a/files/0'],
			['link out of kit/src', { a: { files: ['src/leak.ts'], layer: 'product' } }, '/components/a/files/0'],
			['undeclared package', { a: { files: ['src/button.ts'], layer: 'product', packages: ['@evil/pkg'] } }, '/components/a/packages/0'],
		]
		for (const [label, components, path] of cases) {
			const refused = await updateComponentRegistryForHttp(session, { expectedRevision: await revision(ctx.app), components, widgets: {} })
			expect(refused.status, label).toBe(400)
			expect(refused.body, label).toMatchObject({ status: 'invalid', code: 'kit.component_invalid', diagnostics: [expect.objectContaining({ code: 'kit.component_invalid', path })] })
		}
		expect(await readFile(ctx.kitPath, 'utf8')).toBe(bytes)
	})

	it('refuses invalid and escaping specifiers and undeclared Design System packages before storing anything', async () => {
		const ctx = await v5Fixture()
		const bytes = await readFile(ctx.kitPath, 'utf8')
		const session = http(ctx.app, HUMAN_EDITOR)
		const compose = async (adapters: string[], designSystems: string[] = []) =>
			composeProductKitForHttp(session, { expectedRevision: await revision(ctx.app), designSystems, adapters })
		for (const [specifier, code] of [
			['./../outside.js', 'product_kit.specifier_refused'],
			['./a/../../outside.js', 'product_kit.specifier_refused'],
			['./node_modules/@acme/uiux-adapter/index.js', 'product_kit.specifier_refused'],
			['./NODE_MODULES/x.js', 'product_kit.specifier_refused'],
			['@evil/adapter', 'product_kit.specifier_refused'],
			['@acme/design-system/../../evil', 'product_kit.specifier_refused'],
			['/etc/passwd', 'workspace.invalid_adapter_specifier'],
			['file:///etc/passwd', 'workspace.invalid_adapter_specifier'],
			['../outside.js', 'workspace.invalid_adapter_specifier'],
		] as const) {
			const refused = await compose([specifier])
			expect(refused.status, specifier).toBe(400)
			expect(refused.body, specifier).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code, path: '/adapters/0/moduleSpecifier' })] })
		}
		const undeclared = await compose(['./uiux.js'], ['@evil/design-system'])
		expect(undeclared.body).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.package_undeclared', path: '/designSystems/0' })] })
		const style = await updateProductKitForHttp(session, { expectedRevision: await revision(ctx.app), adapters: [{ moduleSpecifier: './uiux.js' }], styles: ['./../theme.css'], themes: {} })
		expect(style.body).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.invalid_style_specifier', path: '/styles/0' })] })
		const undeclaredStyle = await updateProductKitForHttp(session, { expectedRevision: await revision(ctx.app), adapters: [{ moduleSpecifier: './uiux.js' }], styles: ['@evil/theme/theme.css'], themes: {} })
		expect(undeclaredStyle.body).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.specifier_refused', path: '/styles/0' })] })
		expect(await readFile(ctx.kitPath, 'utf8')).toBe(bytes)
	})

	it('answers a stale expectedRevision with a conflict and writes nothing', async () => {
		const ctx = await v5Fixture()
		const stale = await revision(ctx.app)
		const session = http(ctx.app, HUMAN_EDITOR)
		expect(await composeProductKitForHttp(session, { expectedRevision: stale, designSystems: [], adapters: ['./uiux.js'] })).toMatchObject({ status: 200 })
		const bytes = await readFile(ctx.kitPath, 'utf8')
		const conflict = await composeProductKitForHttp(session, { expectedRevision: stale, designSystems: ['@acme/design-system'], adapters: ['./uiux.js'] })
		expect(conflict).toMatchObject({ status: 409, body: { status: 'conflict', currentRevision: await revision(ctx.app) } })
		expect(await readFile(ctx.kitPath, 'utf8')).toBe(bytes)
	})

	it('refuses on a Workspace below schemaVersion 5 with workspace.migration_required, over HTTP and MCP', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-product-kit-legacy-')))
		roots.push(root)
		await writeManifest(root, currentManifest())
		const app = createWorkspaceApplicationSession(new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }))
		const refused = await composeProductKitForHttp(http(app, HUMAN_EDITOR), { expectedRevision: 'sha256:x', designSystems: [], adapters: [] })
		expect(refused).toMatchObject({ status: 422, body: { status: 'blocked', code: 'workspace.migration_required' } })
		expect(await readProductKitForHttp(http(app, HUMAN_EDITOR))).toMatchObject({ status: 404 })
		const mcp = await connectMcp(app, AGENT)
		try {
			const viaMcp = await mcp.client.callTool({ name: 'update_component_registry', arguments: { expectedRevision: 'sha256:x', components: {}, widgets: {} } })
			expect(viaMcp.isError).toBe(true)
			expect(viaMcp.structuredContent).toMatchObject({ status: 'blocked', code: 'workspace.migration_required' })
			await expect(mcp.client.readResource({ uri: 'uiux://product-kit' })).rejects.toThrow(/not found/iu)
		}
		finally { await mcp.close() }
	})

	it('updates the Workspace settings without adapters from schemaVersion 5 and refuses adapters there (Clause 01a11485-f769)', async () => {
		const ctx = await v5Fixture()
		const current = await ctx.app.readPointResource('workspace', 'workspace')
		if (current?.kind !== 'workspace') throw new Error('workspace')
		const session = http(ctx.app, HUMAN_EDITOR)
		const settings = { i18n: { defaultLocale: 'zh-TW' }, viewports: {}, themes: {} }
		const updated = await updateWorkspaceSettingsForHttp(session, { expectedRevision: current.revision, settings })
		expect(updated, JSON.stringify(updated.body)).toMatchObject({ status: 200, body: { status: 'updated' } })
		const next = await ctx.app.readPointResource('workspace', 'workspace')
		const refused = await updateWorkspaceSettingsForHttp(session, { expectedRevision: next!.revision, settings: { ...settings, adapters: [{ moduleSpecifier: './uiux.js' }] } })
		expect(refused).toMatchObject({ status: 400, body: { status: 'invalid' } })
	})
})

describe('Product Kit authorization (Clauses 01a11bb1-b35a and 01a11bb1-b3c2)', () => {
	it('refuses each operation without its key, naming it, and writes nothing', async () => {
		const ctx = await v5Fixture()
		const bytes = await readFile(ctx.kitPath, 'utf8')
		const rev = await revision(ctx.app)
		const compose = { expectedRevision: rev, designSystems: [], adapters: ['./uiux.js'] }
		const update = { expectedRevision: rev, adapters: [{ moduleSpecifier: './uiux.js' }], styles: [], themes: {} }
		const registry = { expectedRevision: rev, components: {}, widgets: {} }

		for (const principal of [VIEWER, WRITER])
			expect(await composeProductKitForHttp(http(ctx.app, principal), compose), principal.nickname).toMatchObject({ status: 403, body: { code: 'auth.scope_denied', requiredKeys: ['product-kit.compose'] } })
		for (const principal of [VIEWER, COMPOSER_ONLY]) {
			expect(await updateProductKitForHttp(http(ctx.app, principal), update), principal.nickname).toMatchObject({ status: 403, body: { code: 'auth.scope_denied', requiredKeys: ['product-kit.write'] } })
			expect(await updateComponentRegistryForHttp(http(ctx.app, principal), registry), principal.nickname).toMatchObject({ status: 403, body: { code: 'auth.scope_denied', requiredKeys: ['product-kit.write'] } })
		}
		const mcp = await connectMcp(ctx.app, testMember({ nickname: 'reader', kind: 'agent', credential: 'token', keys: ['workspace.read'] }))
		try {
			const denied = await mcp.client.callTool({ name: 'compose_product_kit', arguments: compose })
			expect(denied.structuredContent).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['product-kit.compose'] })
			// Reading the Product Kit needs only workspace.read.
			const read = await mcp.client.readResource({ uri: 'uiux://product-kit' })
			const content = read.contents[0]
			expect(content && 'text' in content ? JSON.parse(content.text) : undefined).toMatchObject({ kind: 'product-kit', revision: rev })
		}
		finally { await mcp.close() }
		expect(await readFile(ctx.kitPath, 'utf8')).toBe(bytes)
		// The keys of each operation are enough on their own (no key implies another).
		expect(await composeProductKitForHttp(http(ctx.app, COMPOSER_ONLY), compose)).toMatchObject({ status: 200 })
		expect(await updateProductKitForHttp(http(ctx.app, WRITER), { ...update, expectedRevision: await revision(ctx.app) })).toMatchObject({ status: 200 })
	})

	it('decides the keys of a change by what it changes', () => {
		const base: ProductKit = { ...KIT, adapters: [{ moduleSpecifier: './a.js', config: { x: 1 } }, { moduleSpecifier: './b.js' }] }
		expect(productKitChangeKeys(base, base)).toEqual([])
		expect(productKitChangeKeys(base, { ...base, designSystems: [] })).toEqual(['product-kit.compose'])
		// Reordering carries each config with its entry: compose only.
		expect(productKitChangeKeys(base, { ...base, adapters: [base.adapters[1]!, base.adapters[0]!] })).toEqual(['product-kit.compose'])
		expect(productKitChangeKeys(base, { ...base, adapters: [base.adapters[0]!] })).toEqual(['product-kit.compose'])
		expect(productKitChangeKeys(base, { ...base, adapters: [...base.adapters, { moduleSpecifier: './c.js', config: {} }] })).toEqual(['product-kit.write', 'product-kit.compose'])
		expect(productKitChangeKeys(base, { ...base, adapters: [{ moduleSpecifier: './a.js' }, base.adapters[1]!] })).toEqual(['product-kit.write'])
		for (const member of ['styles', 'themes', 'components', 'widgets'] as const)
			expect(productKitChangeKeys(base, { ...base, [member]: member === 'styles' ? ['./x.css'] : { x: {} } }), member).toEqual(['product-kit.write'])
		// A malformed side fails closed.
		expect(productKitChangeKeys(undefined, base)).toEqual(['product-kit.write', 'product-kit.compose'])
	})

	it('decides the keys on the file the write replaces, even when another write lands between authorization and the write', async () => {
		const ctx = await v5Fixture()
		const original = await revision(ctx.app)
		// The concurrent composition the racing session lands, which re-points the Adapter.
		const racing: WorkspaceApplicationSession = {
			...ctx.app,
			updateProductKit: (async (command, guard) => {
				const composed = await ctx.app.composeProductKit({ expectedRevision: original, designSystems: [], adapters: ['@acme/uiux-adapter'] })
				expect(composed).toMatchObject({ status: 'updated' })
				return ctx.app.updateProductKit({ ...command, expectedRevision: (composed as { revision: string }).revision }, guard)
			}) as WorkspaceApplicationSession['updateProductKit'],
		}
		const outcome = await updateProductKitForHttp(http(racing, WRITER), { expectedRevision: original, adapters: [{ moduleSpecifier: './uiux.js', config: { density: 'airy' } }], styles: [], themes: {} })
		// The request still names the old Adapter, which the file it would replace no longer holds.
		expect(outcome).toMatchObject({ status: 400, body: { status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.adapters_not_current' })] } })
		const stored = JSON.parse(await readFile(ctx.kitPath, 'utf8'))
		expect(stored.adapters).toEqual([{ moduleSpecifier: '@acme/uiux-adapter' }])
	})
})

describe('the product-kit edit lease (Rule 01a11485-efb6)', () => {
	it('lets an Agent\'s write take the lease, which locks out another Agent and a human, while a human write takes none', async () => {
		const ctx = await v5Fixture()
		const leases = createLeaseManager()
		const mcp = await connectMcp(ctx.app, AGENT, { leases })
		try {
			const first = await mcp.client.callTool({ name: 'compose_product_kit', arguments: { expectedRevision: await revision(ctx.app), designSystems: ['@acme/design-system'], adapters: ['./uiux.js'] } })
			expect(first.isError, JSON.stringify(first.structuredContent)).not.toBe(true)
			expect(leases.list()).toEqual([expect.objectContaining({ kind: 'product-kit', key: 'product-kit', holder: expect.objectContaining({ nickname: 'claude', kind: 'agent' }) })])

			const human = await updateComponentRegistryForHttp(http(ctx.app, HUMAN_EDITOR, leases), { expectedRevision: await revision(ctx.app), components: {}, widgets: {} })
			expect(human).toMatchObject({ status: 423, body: { status: 'locked', code: 'resource.locked', lock: { kind: 'product-kit', key: 'product-kit', holder: { nickname: 'claude' } } } })
			const other = http(ctx.app, OTHER_AGENT, leases)
			expect(other.acquireLeases({ resources: [{ kind: 'product-kit', key: 'product-kit' }] })).toMatchObject({ status: 'locked' })
			expect(other.acquireLeases({ resources: [{ kind: 'product-kit', key: 'kit' }] })).toMatchObject({ status: 'invalid', code: 'lease.invalid_resources' })

			const released = await mcp.client.callTool({ name: 'release_lock', arguments: {} })
			expect(released.structuredContent).toMatchObject({ status: 'released', released: [{ kind: 'product-kit', key: 'product-kit' }] })
		}
		finally { await mcp.close() }

		expect(await updateComponentRegistryForHttp(http(ctx.app, HUMAN_EDITOR, leases), { expectedRevision: await revision(ctx.app), components: {}, widgets: {} })).toMatchObject({ status: 200 })
		expect(leases.list()).toEqual([])
		// Acquiring the lease needs product-kit.write (Rule 01a11c09-c125).
		expect(http(ctx.app, COMPOSER_ONLY, leases).acquireLeases({ resources: [{ kind: 'product-kit', key: 'product-kit' }] })).toMatchObject({ status: 'blocked', requiredKeys: ['product-kit.write'] })
	})
})

describe('the uiux://product-kit Resource (Clause 01a11bb1-b0f1)', () => {
	it('holds the file, the build state, the Adapter resolution, the resolved packages and the findings, with no host path', async () => {
		const ctx = await v5Fixture({
			...KIT,
			adapters: [...KIT.adapters, { moduleSpecifier: '@acme/uiux-adapter' }],
			components: { ghost: { files: ['src/ghost.ts'], layer: 'product' } },
		})
		const mcp = await connectMcp(ctx.app, AGENT)
		try {
			const read = await mcp.client.readResource({ uri: 'uiux://product-kit' })
			const content = read.contents[0]
			const text = content && 'text' in content ? content.text : ''
			expect(JSON.parse(text)).toMatchObject({
				kind: 'product-kit',
				key: 'product-kit',
				resource: { designSystems: ['@acme/design-system'] },
				revision: await revision(ctx.app),
				build: { state: 'none' },
				adapters: [
					{ moduleSpecifier: './uiux.js', status: 'resolved', path: 'uiux.js' },
					{ moduleSpecifier: '@acme/uiux-adapter', status: 'failed' },
				],
				packages: [{ package: '@acme/design-system', status: 'resolved', version: '1.4.2', linked: false }],
				findings: [expect.objectContaining({ code: 'kit.component_invalid', path: '/components/ghost/files/0' })],
			})
			expect(text).not.toContain(ctx.root)
		}
		finally { await mcp.close() }
		expect(await readProductKitForHttp(http(ctx.app, VIEWER))).toMatchObject({ status: 200, body: { kind: 'product-kit' } })
	})
})
