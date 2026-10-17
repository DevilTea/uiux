import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { checkProductKitAgainstKit, maskHostPaths, scanImportSpecifiers } from '../src/adapters/kit-registry'
import { NodeWorkspaceAdapterModuleResolver } from '../src/adapters/resolution'
import { createLeaseManager, type LeaseManager } from '../src/application/access/leases'
import { productKitChangeKeys } from '../src/application/access/policy'
import type { MemberPrincipal } from '../src/application/access/principal'
import { createHistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { HostVersionRecord } from '../src/domain/history/schema'
import { builtInAccessPresetsFile } from '../src/domain/access-presets/schema'
import { emptyProductKit, type ProductKit } from '../src/domain/product-kit/schema'
import { createHistoryStoreFactory } from '../src/server/history-stores'
import { canonicalJsonBytes, FileNativePersistence, LEGACY_LAYOUT, V5_LAYOUT } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import {
	composeProductKitForHttp,
	readProductKitForHttp,
	updateComponentRegistryForHttp,
	updateProductKitForHttp,
	updateWorkspaceSettingsForHttp,
} from '../src/server/authoring-http'
import { connectMcp, scoped, testMember } from './support/access'
import { currentManifest, writeManifest } from './support/workspace-layout'

/**
 * The Product Kit authoring operations (issue #141, units K5 and K6) on a current-schema Workspace:
 * Clauses 01a11bb1-b15c-…, 01a11bb1-b35a-…, 01a11bb1-b3c2-…,
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

/** A current-schema Workspace whose kit project declares two packages and holds a plain-module Adapter and three component files. */
async function kitFixture(kit: ProductKit = KIT, parent?: string) {
	const root = parent ? join(parent, 'workspace') : await realpath(await mkdtemp(join(tmpdir(), 'uiux-product-kit-')))
	if (parent) await mkdir(root)
	else roots.push(root)
	await writeManifest(root, canonicalJsonBytes(currentManifest()), V5_LAYOUT)
	await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes(kit))
	await writeFile(join(root, 'access-presets.json'), canonicalJsonBytes(builtInAccessPresetsFile()))
	await write(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', private: true, dependencies: { '@acme/design-system': '^1.0.0', '@acme/uiux-adapter': '^2.0.0' } }))
	await write(join(root, 'kit', 'node_modules', '@acme', 'design-system', 'package.json'), JSON.stringify({ name: '@acme/design-system', version: '1.4.2' }))
	await write(join(root, 'kit', 'uiux.js'), 'export const adapter = {}\n')
	await write(join(root, 'kit', 'src', 'button.ts'), 'export const button = 1\n')
	await write(join(root, 'kit', 'src', 'money.ts'), 'export const money = 1\n')
	await write(join(root, 'kit', 'src', 'card.ts'), 'import { money } from \'./money\'\nimport { button } from \'./button.js\'\nexport const card = money + button\n')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
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
		const ctx = await kitFixture()
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
		const ctx = await kitFixture()
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
		const ctx = await kitFixture()
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
		const ctx = await kitFixture({ ...KIT, adapters: [{ moduleSpecifier: './src/wrapper.js' }] })
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
		const ctx = await kitFixture()
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
		const handler = await updateProductKitForHttp(session, { expectedRevision: await revision(ctx.app), adapters: [{ moduleSpecifier: './uiux.js' }], styles: [], themes: { t: { onclick: 'alert(document.cookie)' } } })
		expect(handler.body).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.theme_attribute_not_allowed', path: '/themes/t/onclick' })] })
		const undeclaredStyle = await updateProductKitForHttp(session, { expectedRevision: await revision(ctx.app), adapters: [{ moduleSpecifier: './uiux.js' }], styles: ['@evil/theme/theme.css'], themes: {} })
		expect(undeclaredStyle.body).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.specifier_refused', path: '/styles/0' })] })
		expect(await readFile(ctx.kitPath, 'utf8')).toBe(bytes)
	})

	it('answers a stale expectedRevision with a conflict and writes nothing', async () => {
		const ctx = await kitFixture()
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
		await writeManifest(root, { ...currentManifest(), schemaVersion: 4, adapters: [] }, LEGACY_LAYOUT)
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
		const ctx = await kitFixture()
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
		const ctx = await kitFixture()
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
		const ctx = await kitFixture()
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
		const ctx = await kitFixture()
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

describe('Product Kit history and restore (Clauses 01a11a5e-216d and 01a11bb1-b35a, Rule 01a11c09-c648)', () => {
	const clock = (): HistoryRecorderClock => ({ now: () => Date.parse('2026-10-11T00:00:00.000Z'), setTimeout: () => Symbol('timer'), clearTimeout: () => undefined })
	const RESTORER = testMember({ nickname: 'rhea', kind: 'human', credential: 'session', keys: ['workspace.read', 'history.read', 'product-kit.source.read', 'product-kit.write', 'history.restore'] })

	async function historyFixture() {
		const base = await kitFixture()
		const home = join(await realpath(await mkdtemp(join(tmpdir(), 'uiux-product-kit-home-'))), 'home')
		roots.push(dirname(home))
		const history = createHistoryStoreFactory({ workspaceRoot: base.root, persistence: base.persistence, home: () => home })
		const recorder = createHistoryRecorder({ persistence: base.persistence, stores: () => history.open(), clock: clock(), log: () => undefined })
		const app = createWorkspaceApplicationSession(base.persistence, { history, historyBoundary: () => recorder })
		const started = await recorder.start()
		return { ...base, app, history, recorder, baseline: started.baseline! }
	}

	it('records each operation as a write event, and restores the Product Kit only with the keys of what the restore changes', async () => {
		const ctx = await historyFixture()
		const mcp = await connectMcp(ctx.app, AGENT)
		try {
			const composed = await mcp.client.callTool({ name: 'compose_product_kit', arguments: { expectedRevision: await revision(ctx.app), designSystems: [], adapters: ['./uiux.js', '@acme/uiux-adapter'] } })
			expect(composed.isError, JSON.stringify(composed.structuredContent)).not.toBe(true)
		}
		finally { await mcp.close() }
		expect(await updateComponentRegistryForHttp(http(ctx.app, HUMAN_EDITOR), { expectedRevision: await revision(ctx.app), components: { button: { files: ['src/button.ts'], layer: 'product' } }, widgets: {} })).toMatchObject({ status: 200 })
		await ctx.recorder.stop()
		const versions = (await (await ctx.history.open())!.host.listVersions()).records as HostVersionRecord[]
		expect(versions.flatMap(version => version.events.map(event => `${event.operation}:${event.source}`))).toEqual(['composeProductKit:mcp', 'updateComponentRegistry:workbench'])

		const current = await revision(ctx.app)
		const restore = { versionId: ctx.baseline, resource: { kind: 'product-kit', key: 'product-kit' }, expectedRevision: current }
		// The baseline holds the other Adapter list and designSystems, so the restore composes.
		expect(await http(ctx.app, RESTORER).restoreResourceVersion(restore)).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['product-kit.compose'] })
		// history.restore never stands in for the kind's write key.
		const noWrite = testMember({ nickname: 'hal', kind: 'human', credential: 'session', keys: ['workspace.read', 'history.read', 'history.restore', 'product-kit.compose'] })
		expect(await http(ctx.app, noWrite).restoreResourceVersion(restore)).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['product-kit.write'] })
		expect(await revision(ctx.app)).toBe(current)

		const restored = await http(ctx.app, HUMAN_EDITOR).restoreResourceVersion(restore)
		expect(restored).toMatchObject({ status: 'updated', kind: 'product-kit', key: 'product-kit', restoredFrom: ctx.baseline })
		expect(JSON.parse(await readFile(ctx.kitPath, 'utf8'))).toEqual(KIT)
	})

	it('decides a restore\'s compose check on the file it replaces, even when a composition lands between authorization and the write', async () => {
		const ctx = await historyFixture()
		const styled = await ctx.app.updateProductKit({ expectedRevision: await revision(ctx.app), adapters: KIT.adapters as never, styles: ['./dist/kit.css'], themes: {} })
		if (styled.status !== 'updated') throw new Error(JSON.stringify(styled))
		const restore = { versionId: ctx.baseline, resource: { kind: 'product-kit', key: 'product-kit' }, expectedRevision: styled.revision as string }

		// The concurrent composition lands after the scoped session authorized the restore and before the service reads the file.
		const racing: WorkspaceApplicationSession = {
			...ctx.app,
			restoreResourceVersion: (async (command, guard) => {
				const composed = await ctx.app.composeProductKit({ expectedRevision: styled.revision, designSystems: ['@acme/design-system'], adapters: ['@acme/uiux-adapter'] })
				if (composed.status !== 'updated') throw new Error(JSON.stringify(composed))
				return ctx.app.restoreResourceVersion({ ...command, expectedRevision: composed.revision }, guard)
			}) as WorkspaceApplicationSession['restoreResourceVersion'],
		}
		expect(await http(racing, RESTORER).restoreResourceVersion(restore)).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['product-kit.compose'] })
		expect(JSON.parse(await readFile(ctx.kitPath, 'utf8')).adapters).toEqual([{ moduleSpecifier: '@acme/uiux-adapter' }])

		// Without the race, the same restore changes only styles, which product-kit.write allows.
		const control = await historyFixture()
		const controlStyled = await control.app.updateProductKit({ expectedRevision: await revision(control.app), adapters: KIT.adapters as never, styles: ['./dist/kit.css'], themes: {} })
		if (controlStyled.status !== 'updated') throw new Error('control')
		expect(await http(control.app, RESTORER).restoreResourceVersion({ ...restore, versionId: control.baseline, expectedRevision: controlStyled.revision })).toMatchObject({ status: 'updated' })
	})

	it('refuses to restore a Product Kit that no longer matches the kit project', async () => {
		const ctx = await historyFixture()
		await rm(join(ctx.root, 'kit', 'package.json'))
		const composed = await ctx.app.composeProductKit({ expectedRevision: await revision(ctx.app), designSystems: [], adapters: ['./uiux.js'] })
		if (composed.status !== 'updated') throw new Error(JSON.stringify(composed))
		const outcome = await http(ctx.app, HUMAN_EDITOR).restoreResourceVersion({ versionId: ctx.baseline, resource: { kind: 'product-kit', key: 'product-kit' }, expectedRevision: composed.revision })
		expect(outcome).toMatchObject({ status: 'invalid', code: 'history.restore_invalid_content', diagnostics: [expect.objectContaining({ code: 'product_kit.package_undeclared', path: '/designSystems/0' })] })
	})

	it('checks a restore\'s keys before the kit project, so a caller without them learns nothing of it', async () => {
		const ctx = await historyFixture()
		await rm(join(ctx.root, 'kit', 'package.json'))
		const composed = await ctx.app.composeProductKit({ expectedRevision: await revision(ctx.app), designSystems: [], adapters: ['./uiux.js'] })
		if (composed.status !== 'updated') throw new Error(JSON.stringify(composed))
		const restore = { versionId: ctx.baseline, resource: { kind: 'product-kit', key: 'product-kit' }, expectedRevision: composed.revision }
		// The restore would also fail the kit project check; the missing key answers first.
		expect(await http(ctx.app, RESTORER).restoreResourceVersion(restore)).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['product-kit.compose'] })
	})
})

describe('the uiux://product-kit Resource (Clause 01a11bb1-b0f1)', () => {
	it('holds the file, the build state, the Adapter resolution, the resolved packages and the findings, with no host path', async () => {
		const ctx = await kitFixture({
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

describe('widgets.import names a declared dependency (#139 owner ruling 2026-10-11, 2)', () => {
	it('refuses an import of a package kit/package.json does not declare, and accepts a declared one with a subpath', async () => {
		const ctx = await kitFixture()
		const bytes = await readFile(ctx.kitPath, 'utf8')
		const session = http(ctx.app, HUMAN_EDITOR)
		for (const specifier of ['@evil/widgets', 'left-pad/x']) {
			const refused = await updateComponentRegistryForHttp(session, { expectedRevision: await revision(ctx.app), components: {}, widgets: { DatePicker: { import: specifier, export: 'DatePicker' } } })
			expect(refused, specifier).toMatchObject({ status: 400, body: { status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.package_undeclared', path: '/widgets/DatePicker/import' })] } })
		}
		expect(await readFile(ctx.kitPath, 'utf8')).toBe(bytes)
		const accepted = await updateComponentRegistryForHttp(session, { expectedRevision: await revision(ctx.app), components: {}, widgets: { DatePicker: { import: '@acme/design-system/date', export: 'DatePicker' } } })
		expect(accepted, JSON.stringify(accepted.body)).toMatchObject({ status: 200 })
	})
})

describe('the service guard of the Product Kit operations', () => {
	it('returns the guard\'s refusal on the file the write replaces, storing nothing, and stores when the guard passes', async () => {
		const ctx = await kitFixture()
		const bytes = await readFile(ctx.kitPath, 'utf8')
		const seen: unknown[] = []
		const refusal = { status: 'refused-by-guard' } as const
		const refused = await ctx.app.composeProductKit({ expectedRevision: await revision(ctx.app), designSystems: [], adapters: ['./uiux.js'] }, (change) => {
			seen.push(change)
			return refusal
		})
		expect(refused).toBe(refusal)
		expect(seen).toEqual([{ current: KIT, next: { ...KIT, designSystems: [] } }])
		expect(await readFile(ctx.kitPath, 'utf8')).toBe(bytes)
		expect(await ctx.app.composeProductKit({ expectedRevision: await revision(ctx.app), designSystems: [], adapters: ['./uiux.js'] }, () => undefined)).toMatchObject({ status: 'updated' })
	})

	it('runs the guard before the checks against the kit project', async () => {
		const ctx = await kitFixture()
		const refusal = { status: 'refused-by-guard' } as const
		// The change would fail the kit project check (an undeclared package); the guard answers first.
		const command = { expectedRevision: await revision(ctx.app), designSystems: ['@evil/design-system'], adapters: ['./uiux.js'] }
		expect(await ctx.app.composeProductKit(command, () => refusal)).toBe(refusal)
		expect(await ctx.app.composeProductKit(command, () => undefined)).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.package_undeclared' })] })
	})
})

describe('the import scan (Rule 01a11bb1-a310)', () => {
	it('reads static, side-effect and dynamic imports, re-exports and require calls', () => {
		const text = [
			'import a from \'./a\'',
			'import {',
			'  b,',
			'  c as d,',
			'} from "./b.js"',
			'import \'./side.css\'',
			'export * from \'./c\'',
			'export { e } from \'./e\'',
			'const f = await import( \'./f\' )',
			'const g = require(\'./g\')',
			'const from = \'./not-an-import\'',
		].join('\n')
		expect(scanImportSpecifiers(text)).toEqual(['./a', './b.js', './side.css', './c', './e', './f', './g'])
	})

	it('reads clauses without spaces, dynamic imports with options and template literals without interpolation', () => {
		const text = [
			'import{a}from\'./a\'',
			'import*as b from"./b"',
			'export*from\'./c\'',
			'export{d}from"./d"',
			'const e = await import(\'./e\', { with: { type: \'json\' } })',
			'const f = await import( "./f" , {})',
			'const g = await import(`./g`)',
			'const h = require(`./h`)',
			'const i = await import(`./${name}`)',
			'const j = require(`./j-${name}`)',
			'const k = `import{x}`',
		].join('\n')
		expect(scanImportSpecifiers(text)).toEqual(['./a', './b', './c', './d', './e', './f', './g', './h'])
	})

	it('scans a pathological 1 MB file well under a second', async () => {
		const size = 1024 * 1024
		const fill = (unit: string, tail = '') => unit.repeat(Math.floor((size - tail.length) / unit.length)) + tail
		for (const text of [fill('import '), fill('export '), fill('export { a, ', 'from \'./x\''), fill('import(\'', ''), fill('from '), fill('import \'a', '\''), fill('import{'), fill('export*'), fill('import(`'), fill('require(`$'), fill('import(\'a\','), fill('import{a}from')]) {
			const started = performance.now()
			scanImportSpecifiers(text)
			expect(performance.now() - started, text.slice(0, 20)).toBeLessThan(500)
		}

		// Through the registry check, with the 1 MB file as a component's entry.
		const ctx = await kitFixture()
		await write(join(ctx.root, 'kit', 'src', 'huge.ts'), fill('import '))
		const next: ProductKit = { ...KIT, components: { huge: { files: ['src/huge.ts'], layer: 'product' } } }
		const started = performance.now()
		const checked = await checkProductKitAgainstKit({ root: ctx.root, codeDirectoryName: 'kit', next })
		expect(performance.now() - started).toBeLessThan(1000)
		expect(checked).toEqual({ refusals: [], findings: [] })
	})

	const manyImports = (count: number) => Array.from({ length: count }, (_, index) => `import './missing-${index}'`).join('\n')

	it('resolves each import once per check, however many components share the file', async () => {
		const ctx = await kitFixture()
		await write(join(ctx.root, 'kit', 'src', 'many.ts'), manyImports(1000))
		const components = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`c${index}`, { files: ['src/many.ts'], layer: 'product' as const }]))
		const started = performance.now()
		const checked = await checkProductKitAgainstKit({ root: ctx.root, codeDirectoryName: 'kit', next: { ...KIT, components } })
		expect(performance.now() - started).toBeLessThan(2000)
		expect(checked).toEqual({ refusals: [], findings: [] })
	})

	it('stops at its limit with one finding', async () => {
		const ctx = await kitFixture()
		const components: ProductKit['components'] = {}
		for (const name of ['a', 'b', 'c', 'd']) {
			await write(join(ctx.root, 'kit', 'src', name, 'many.ts'), manyImports(1000))
			components[name] = { files: [`src/${name}/many.ts`], layer: 'product' }
		}
		const started = performance.now()
		const checked = await checkProductKitAgainstKit({ root: ctx.root, codeDirectoryName: 'kit', next: { ...KIT, components } })
		expect(performance.now() - started).toBeLessThan(2000)
		expect(checked.refusals).toEqual([])
		expect(checked.findings).toEqual([expect.objectContaining({ code: 'kit.component_invalid', path: '/components', message: expect.stringContaining('limit') })])
	})
})

describe('kit project containment', () => {
	/** A directory outside the Workspace holding a whole kit project, with a package version to look for. */
	async function outsideKit(): Promise<string> {
		const outside = await realpath(await mkdtemp(join(tmpdir(), 'uiux-product-kit-outside-')))
		roots.push(outside)
		await write(join(outside, 'package.json'), JSON.stringify({ name: 'outside', dependencies: { '@acme/design-system': '^9.0.0', '@outside/secret': '^1.0.0' } }))
		await write(join(outside, 'node_modules', '@acme', 'design-system', 'package.json'), JSON.stringify({ name: '@acme/design-system', version: '9.9.9' }))
		await write(join(outside, 'src', 'button.ts'), 'export const button = 1\n')
		await write(join(outside, 'src', 'secret.ts'), 'export const secret = 1\n')
		await write(join(outside, 'secret.ts'), 'export const secret = 1\n')
		return outside
	}

	const registry = { button: { files: ['src/button.ts'], layer: 'product' as const } }
	const present = { probe: { files: ['src/button.ts'], layer: 'product' as const } }
	const missing = { probe: { files: ['src/absent.ts'], layer: 'product' as const } }
	const shape = (outcome: { body: unknown }) => JSON.stringify(outcome.body).replaceAll('absent.ts', 'button.ts')

	for (const [label, link] of [
		['kit/ is a symbolic link out of the Workspace', async (root: string, outside: string) => {
			await rm(join(root, 'kit'), { recursive: true })
			await symlink(outside, join(root, 'kit'))
		}],
		['kit/src/ is a symbolic link out of the Workspace', async (root: string, outside: string) => {
			await rm(join(root, 'kit', 'src'), { recursive: true })
			await symlink(join(outside, 'src'), join(root, 'kit', 'src'))
		}],
	] as const) {
		it(`answers as for a missing file when ${label}, and reads nothing there`, async () => {
			const outside = await outsideKit()
			const ctx = await kitFixture({ ...KIT, components: registry })
			await link(ctx.root, outside)
			const read = await ctx.app.readProductKit()
			const text = JSON.stringify(read)
			expect(read?.findings).toContainEqual(expect.objectContaining({ code: 'kit.component_invalid', path: '/components/button/files/0' }))
			expect(text).not.toContain('9.9.9')
			expect(text).not.toContain(outside)

			const session = http(ctx.app, HUMAN_EDITOR)
			const outsideFile = await updateComponentRegistryForHttp(session, { expectedRevision: await revision(ctx.app), components: present, widgets: {} })
			const absent = await updateComponentRegistryForHttp(session, { expectedRevision: await revision(ctx.app), components: missing, widgets: {} })
			expect(outsideFile).toMatchObject({ status: 400, body: { code: 'kit.component_invalid' } })
			expect(shape(outsideFile)).toBe(shape(absent))
			// A package only the outside kit/package.json declares is not declared.
			const secret = await composeProductKitForHttp(session, { expectedRevision: await revision(ctx.app), designSystems: ['@outside/secret'], adapters: ['./uiux.js'] })
			expect(secret).toMatchObject({ status: 400, body: { diagnostics: [expect.objectContaining({ code: 'product_kit.package_undeclared' })] } })
		})
	}

	it('answers as for a missing file for a link inside kit/src/ out of the Workspace, and the import scan does not follow it', async () => {
		const outside = await outsideKit()
		const ctx = await kitFixture()
		await symlink(join(outside, 'secret.ts'), join(ctx.root, 'kit', 'src', 'leak.ts'))
		await symlink(join(outside, 'nothing.ts'), join(ctx.root, 'kit', 'src', 'dangling.ts'))
		await symlink(join(outside, 'src'), join(ctx.root, 'kit', 'src', 'out'))
		const session = http(ctx.app, HUMAN_EDITOR)
		const answers: string[] = []
		for (const file of ['src/leak.ts', 'src/dangling.ts', 'src/out/secret.ts', 'src/out/nothing.ts', 'src/absent.ts']) {
			const outcome = await updateComponentRegistryForHttp(session, { expectedRevision: await revision(ctx.app), components: { a: { files: [file], layer: 'product' } }, widgets: {} })
			expect(outcome, file).toMatchObject({ status: 400, body: { code: 'kit.component_invalid' } })
			answers.push(JSON.stringify(outcome.body).replaceAll(file, '<file>'))
		}
		expect(new Set(answers).size).toBe(1)

		// An import through the link names nothing, as an import of a missing file.
		await write(join(ctx.root, 'kit', 'src', 'probe.ts'), 'import { secret } from \'./out/secret\'\nimport { nothing } from \'./out/nothing\'\nexport const probe = secret + nothing\n')
		const registered = await updateComponentRegistryForHttp(session, { expectedRevision: await revision(ctx.app), components: { probe: { files: ['src/probe.ts'], layer: 'product' } }, widgets: {} })
		expect(registered, JSON.stringify(registered.body)).toMatchObject({ status: 200, body: { findings: [] } })
	})

	it('reports a Design System package linked out of the Workspace without its version, and never looks above the Workspace', async () => {
		const outside = await outsideKit()
		const ctx = await kitFixture()
		await rm(join(ctx.root, 'kit', 'node_modules', '@acme', 'design-system'), { recursive: true })
		await symlink(join(outside, 'node_modules', '@acme', 'design-system'), join(ctx.root, 'kit', 'node_modules', '@acme', 'design-system'))
		const read = await ctx.app.readProductKit()
		expect(read?.packages).toEqual([{ package: '@acme/design-system', status: 'resolved', linked: true }])
		expect(JSON.stringify(read)).not.toContain('9.9.9')

		// A package installed only in a directory enclosing the Workspace is missing.
		const parent = await realpath(await mkdtemp(join(tmpdir(), 'uiux-product-kit-parent-')))
		roots.push(parent)
		await write(join(parent, 'node_modules', '@acme', 'design-system', 'package.json'), JSON.stringify({ name: '@acme/design-system', version: '7.7.7' }))
		const nested = await kitFixture(KIT, parent)
		await rm(join(nested.root, 'kit', 'node_modules'), { recursive: true })
		const nestedRead = await nested.app.readProductKit()
		expect(nestedRead?.packages).toEqual([{ package: '@acme/design-system', status: 'missing' }])
	})

	it('answers one way for a ./ Adapter through a link out of the Workspace, whether or not its target exists', async () => {
		const outside = await outsideKit()
		const ctx = await kitFixture()
		await symlink(join(outside, 'src'), join(ctx.root, 'kit', 'link'))
		await symlink(join(outside, 'gone'), join(ctx.root, 'kit', 'gone'))
		await symlink(join(outside, 'secret.ts'), join(ctx.root, 'kit', 'leak.ts'))
		await symlink(join(outside, 'nothing.ts'), join(ctx.root, 'kit', 'dangling.ts'))
		const specifiers = ['./link/secret.ts', './link/nothing.ts', './link/deeper/nothing.ts', './gone/x.ts', './leak.ts', './dangling.ts', './absent.ts']
		await writeFile(ctx.kitPath, canonicalJsonBytes({ ...KIT, adapters: specifiers.map(moduleSpecifier => ({ moduleSpecifier })) }))
		const read = await ctx.app.readProductKit()
		const answers = new Set(read?.adapters.map(entry => JSON.stringify({ ...entry, moduleSpecifier: '<specifier>', ...('message' in entry ? { message: entry.message.replace(entry.moduleSpecifier, '<specifier>') } : {}) })))
		expect(read?.adapters.map(entry => entry.status)).toEqual(specifiers.map(() => 'failed'))
		expect([...answers]).toEqual([JSON.stringify({ moduleSpecifier: '<specifier>', status: 'failed', message: 'Adapter module specifier <specifier> does not resolve to a file inside kit/.' })])
		const text = JSON.stringify(read)
		expect(text).not.toContain(outside)
		expect(text).not.toContain('<path>')
	})

	for (const [label, link] of [
		['kit/node_modules/ is a link out of the Workspace', async (root: string, outside: string) => {
			await rm(join(root, 'kit', 'node_modules'), { recursive: true })
			await symlink(join(outside, 'node_modules'), join(root, 'kit', 'node_modules'))
		}],
		['a scope directory in kit/node_modules/ is a link out of the Workspace', async (root: string, outside: string) => {
			await rm(join(root, 'kit', 'node_modules', '@acme'), { recursive: true })
			await symlink(join(outside, 'node_modules', '@acme'), join(root, 'kit', 'node_modules', '@acme'))
		}],
	] as const) {
		it(`reports a package as linked, whether or not it exists there, when ${label}`, async () => {
			const outside = await outsideKit()
			const ctx = await kitFixture({ ...KIT, designSystems: ['@acme/design-system', '@acme/absent'] })
			await link(ctx.root, outside)
			const read = await ctx.app.readProductKit()
			expect(read?.packages).toEqual([
				{ package: '@acme/design-system', status: 'resolved', linked: true },
				{ package: '@acme/absent', status: 'resolved', linked: true },
			])
			expect(JSON.stringify(read)).not.toContain('9.9.9')
		})
	}

	for (const [label, link] of [
		['the package directory', async (root: string, outside: string, target: string) => {
			await symlink(join(outside, 'node_modules', '@acme', target), join(root, 'kit', 'node_modules', '@acme', 'uiux-adapter'))
		}],
		['kit/node_modules/', async (root: string, outside: string, target: string) => {
			if (target === 'adapter') await rename(join(outside, 'node_modules', '@acme', target), join(outside, 'node_modules', '@acme', 'uiux-adapter'))
			await rm(join(root, 'kit', 'node_modules'), { recursive: true })
			await symlink(join(outside, 'node_modules'), join(root, 'kit', 'node_modules'))
		}],
	] as const) {
		it(`reports a bare Adapter one way through a link out of the Workspace at ${label}, whether or not its target exists`, async () => {
			const answers: unknown[] = []
			for (const target of ['adapter', 'absent']) {
				const outside = await outsideKit()
				await write(join(outside, 'node_modules', '@acme', 'adapter', 'package.json'), JSON.stringify({ name: '@acme/uiux-adapter', version: '9.9.9', type: 'module', exports: { './uiux': './uiux.js' } }))
				await write(join(outside, 'node_modules', '@acme', 'adapter', 'uiux.js'), 'export const adapter = {}\n')
				const ctx = await kitFixture({ ...KIT, adapters: [{ moduleSpecifier: '@acme/uiux-adapter/uiux' }] })
				await link(ctx.root, outside, target)
				const read = await ctx.app.readProductKit()
				answers.push(read?.adapters)
				const text = JSON.stringify(read)
				expect(text).not.toContain(outside)
				expect(text).not.toContain('9.9.9')
				// Loading is unchanged: the linked package that exists still resolves.
				const resolving = new NodeWorkspaceAdapterModuleResolver({ layout: ctx.persistence.layout }).resolve(ctx.root, '@acme/uiux-adapter/uiux')
				if (target === 'adapter') await expect(resolving).resolves.toMatchObject({ resolvedPath: await realpath(join(ctx.root, 'kit', 'node_modules', '@acme', 'uiux-adapter', 'uiux.js')) })
				else await expect(resolving).rejects.toThrow()
			}
			expect(answers).toEqual([
				[{ moduleSpecifier: '@acme/uiux-adapter/uiux', status: 'resolved' }],
				[{ moduleSpecifier: '@acme/uiux-adapter/uiux', status: 'resolved' }],
			])
		})
	}

	for (const [label, link] of [
		['the module file', async (pkg: string, outside: string, target: string) => {
			await symlink(join(outside, 'lib', target), join(pkg, 'dist', 'uiux.js'))
		}],
		['a directory above the module file', async (pkg: string, outside: string, target: string) => {
			await rm(join(pkg, 'dist'), { recursive: true })
			await symlink(join(outside, target === 'uiux.js' ? 'lib' : 'gone'), join(pkg, 'dist'))
		}],
	] as const) {
		it(`reports a bare Adapter one way when ${label} of a package in the Workspace links out of it, whether or not its target exists`, async () => {
			const answers: unknown[] = []
			for (const target of ['uiux.js', 'nothing.js']) {
				const outside = await outsideKit()
				await write(join(outside, 'lib', 'uiux.js'), 'export const adapter = {}\n')
				const ctx = await kitFixture({ ...KIT, adapters: [{ moduleSpecifier: '@acme/uiux-adapter/uiux' }] })
				const pkg = join(ctx.root, 'kit', 'node_modules', '@acme', 'uiux-adapter')
				await write(join(pkg, 'package.json'), JSON.stringify({ name: '@acme/uiux-adapter', version: '2.0.0', type: 'module', exports: { './uiux': './dist/uiux.js' } }))
				await mkdir(join(pkg, 'dist'))
				await link(pkg, outside, target)
				const read = await ctx.app.readProductKit()
				answers.push(read?.adapters)
				expect(JSON.stringify(read)).not.toContain(outside)
				// Loading is unchanged: the linked module that exists still resolves.
				const resolving = new NodeWorkspaceAdapterModuleResolver({ layout: ctx.persistence.layout }).resolve(ctx.root, '@acme/uiux-adapter/uiux')
				if (target === 'uiux.js') await expect(resolving).resolves.toMatchObject({ resolvedPath: join(outside, 'lib', 'uiux.js') })
				else await expect(resolving).rejects.toThrow('Adapter module specifier @acme/uiux-adapter/uiux does not resolve to a readable module file.')
			}
			expect(answers).toEqual([
				[{ moduleSpecifier: '@acme/uiux-adapter/uiux', status: 'resolved' }],
				[{ moduleSpecifier: '@acme/uiux-adapter/uiux', status: 'resolved' }],
			])
		})
	}

	it('still reports a missing module file of a package in the Workspace, with no link on its way, as failed', async () => {
		const ctx = await kitFixture({ ...KIT, adapters: [{ moduleSpecifier: '@acme/uiux-adapter/uiux' }] })
		await write(join(ctx.root, 'kit', 'node_modules', '@acme', 'uiux-adapter', 'package.json'), JSON.stringify({ name: '@acme/uiux-adapter', exports: { './uiux': './dist/uiux.js' } }))
		const read = await ctx.app.readProductKit()
		expect(read?.adapters).toEqual([expect.objectContaining({ moduleSpecifier: '@acme/uiux-adapter/uiux', status: 'failed', message: expect.stringContaining('<workspace>/kit/node_modules/@acme/uiux-adapter/dist/uiux.js') })])
		expect(JSON.stringify(read)).not.toContain(ctx.root)
	})
})

describe('host paths in the Product Kit Resource', () => {
	it('masks absolute paths and file URLs, keeping the Workspace root as <workspace>', () => {
		const root = '/srv/acme/workspace'
		expect(maskHostPaths(`Cannot find package 'x' imported from ${root}/kit/.uiux-adapter-resolution.mjs`, [root])).toBe('Cannot find package \'x\' imported from <workspace>/kit/.uiux-adapter-resolution.mjs')
		expect(maskHostPaths('Package subpath \'.\' is not defined by "exports" in /home/someone/node_modules/x/package.json imported from file:///home/someone/a.mjs', [root])).toBe('Package subpath \'.\' is not defined by "exports" in <path> <path>')
		expect(maskHostPaths('at (C:\\Users\\someone\\x.js) and \\\\server\\share\\y.js', [root])).toBe('at (<path>) and <path>')
		expect(maskHostPaths('kit/package.json is not a regular file.', [root])).toBe('kit/package.json is not a regular file.')
	})

	it('keeps <workspace> to paths inside the root, by path segment', () => {
		const root = '/srv/acme/ws'
		expect(maskHostPaths(`in ${root}`, [root])).toBe('in <workspace>')
		expect(maskHostPaths(`in ${root}/kit/a.mjs.`, [root])).toBe('in <workspace>/kit/a.mjs.')
		expect(maskHostPaths(`in ${root}-other/kit/a.mjs and ${root}other`, [root])).toBe('in <path> <path>')
		expect(maskHostPaths(`in /mnt${root}/kit/a.mjs`, [root])).toBe('in <path>')
		expect(maskHostPaths(`in file://${root}-other/a.mjs`, [root])).toBe('in <path>')
		expect(maskHostPaths(`in "${root}-other/a.mjs"`, [root])).toBe('in "<path>"')
		// The longer of two roots wins.
		expect(maskHostPaths(`in ${root}/kit/a.mjs`, ['/srv', root])).toBe('in <workspace>/kit/a.mjs')
	})

	it('masks a path that leaves the root through ..', () => {
		const root = '/srv/acme/ws'
		expect(maskHostPaths(`in ${root}/../x.mjs`, [root])).toBe('in <path>')
		expect(maskHostPaths(`in ${root}/kit/../../other/x.mjs`, [root])).toBe('in <path>')
		expect(maskHostPaths(`in '${root}/..'`, [root])).toBe('in \'<path>\'')
		expect(maskHostPaths(`in file://${root}/../x.mjs`, [root])).toBe('in <path>')
		expect(maskHostPaths(`in ${root}/kit/../src/a.ts`, [root])).toBe('in <workspace>/src/a.ts')
	})

	it('masks a path with spaces whole', () => {
		const root = '/srv/my acme/ws'
		expect(maskHostPaths('Cannot find module \'/Users/John Smith/My File.js\' imported from "/Users/John Smith/a b.mjs"', [root])).toBe('Cannot find module \'<path>\' imported from "<path>"')
		expect(maskHostPaths('in /Users/John Smith/node_modules/x/package.json imported from /home/a b/c d.mjs', [root])).toBe('in <path> <path>')
		expect(maskHostPaths('at file:///Users/John%20Smith/x.js', [root])).toBe('at <path>')
		expect(maskHostPaths(`in ${root}/kit/a b.mjs imported from file:///srv/my%20acme/ws/kit/x.mjs`, [root])).toBe('in <workspace>/kit/a b.mjs imported from <workspace>/kit/x.mjs')
		expect(maskHostPaths(`in '${root}/kit/a.mjs'`, [root])).toBe('in \'<workspace>/kit/a.mjs\'')
	})

	// Once an absolute path starts, it is masked to the line end, a quote, the next path or
	// path-terminating punctuation, so the words after a path may be masked with it.
	const root = '/srv/acme/ws'
	it.each([
		['the root after a non-path character', `;${root}/kit/a.js`, ';<workspace>/kit/a.js'],
		['the root after a word', `x${root}/kit/a.js`, 'x<workspace>/kit/a.js'],
		['the root inside another path', `in /mnt${root}/kit/a.js`, 'in <path>'],
		['the root inside a path below the root', `in ${root}/kit${root}/a.js`, 'in <workspace>/kit/srv/acme/ws/a.js'],
		['a path after ;', 'x;/home/someone/a.js', 'x;<path>'],
		['a path after |', 'a|/home/someone/a.js', 'a|<path>'],
		['a path after >', '>/home/someone/a.js', '><path>'],
		['a path in braces', '{/home/someone/a.js}', '{<path>}'],
		['a path after <', '</home/someone/a.js', '<<path>'],
		['a path after !', '!/home/someone/a.js', '!<path>'],
		['a path after @', 'x@/home/someone/a.js', 'x@<path>'],
		['a path after -', '-/home/someone/a.js', '-<path>'],
		['an apostrophe in a bare path', 'in /home/o\'brien/x.js', 'in <path>'],
		['an apostrophe in a quoted path', 'in \'/home/o\'brien/x.js\' from /home/o\'brien/a.mjs', 'in \'<path>\' from <path>'],
		['an apostrophe in a file URL', 'at file:///home/o\'brien/x.js', 'at <path>'],
		['tabs', 'in\t/home/a\tb/x.js\tz', 'in\t<path>'],
		['a next word with no separator or extension', 'in /Users/John Smith', 'in <path>'],
		['an outside path after a Workspace path', `in ${root}/kit/a.mjs imported from /home/x/y.mjs`, 'in <workspace>/kit/a.mjs imported from <path>'],
		['a path ended by punctuation', 'in /home/x/a.js, then (/home/y/b.js).', 'in <path>, then (<path>).'],
		['a path on its own line', 'in /home/x/a.js\nnext line', 'in <path>\nnext line'],
		['a relative path', 'kit/src/a.js and ./b.js', 'kit/src/a.js and ./b.js'],
		['a lone slash', 'a / b', 'a / b'],
		['a directory name ending in .', 'in /Users/J. Smith/other/x', 'in <path>'],
		['a directory name ending in ;', 'in /Users/J; Smith/other/x', 'in <path>'],
		['a directory name ending in :', 'in /Users/J: Smith/other/x', 'in <path>'],
		['a directory name ending in !', 'in /Users/J! Smith/other/x', 'in <path>'],
		['a directory name ending in ?', 'in /Users/J? Smith/other/x', 'in <path>'],
		['a directory name ending in }', 'in /Users/J} Smith/other/x', 'in <path>'],
		['a directory name ending in |', 'in /Users/J| Smith/other/x', 'in <path>'],
		['a directory name ending in . before a Windows separator', 'in C:\\Users\\J. Smith\\x', 'in <path>'],
		['the root alone before prose', `Workspace ${root} is not writable`, 'Workspace <workspace> is not writable'],
		['the root alone before punctuation', `Workspace ${root}. Next`, 'Workspace <workspace>. Next'],
		['a sibling of the root sharing its name', `in ${root}.bak/x`, 'in <path>'],
		['a sibling of the root with a space', `in ${root} other/x`, 'in <path>'],
	])('masks %s', (_case, message, masked) => {
		expect(maskHostPaths(message, [root])).toBe(masked)
	})

	it('masks in linear time across long runs of whitespace and punctuation', () => {
		const whitespace = ' \t\u00A0\u2003'.repeat(10_000)
		const started = performance.now()
		expect(maskHostPaths(`in /home/x${whitespace}`, [root])).toBe(`in <path>${whitespace}`)
		maskHostPaths(`in /home/x.${whitespace}y`, [root])
		maskHostPaths(`in ${root}${whitespace}y`, [root])
		maskHostPaths(`in /home/x${'.;'.repeat(20_000)} y`, [root])
		expect(performance.now() - started).toBeLessThan(50)
	})

	it('names no host path outside the Workspace in an Adapter\'s resolution failure', async () => {
		const parent = await realpath(await mkdtemp(join(tmpdir(), 'uiux-product-kit-parent-')))
		roots.push(parent)
		// The declared Adapter package is not installed in kit/, so Node resolution finds the one above the Workspace, whose exports refuse it.
		await write(join(parent, 'node_modules', '@acme', 'uiux-adapter', 'package.json'), JSON.stringify({ name: '@acme/uiux-adapter', version: '2.0.0', exports: { './other': './other.js' } }))
		const ctx = await kitFixture({ ...KIT, adapters: [{ moduleSpecifier: '@acme/uiux-adapter' }] }, parent)
		const read = await ctx.app.readProductKit()
		expect(read?.adapters).toEqual([expect.objectContaining({ moduleSpecifier: '@acme/uiux-adapter', status: 'failed', message: expect.stringContaining('<path>') })])
		const text = JSON.stringify(read)
		expect(text).not.toContain(parent)
		expect(text).not.toContain(tmpdir())
	})
})

describe('authoring never writes inside the kit project (Scenario 01a11bb1-c0b4)', () => {
	/** Every file under `kit/`, with its bytes. */
	async function kitTree(root: string): Promise<Record<string, string>> {
		const files: Record<string, string> = {}
		for (const entry of await readdir(join(root, 'kit'), { recursive: true, withFileTypes: true })) {
			if (!entry.isFile()) continue
			const path = join(entry.parentPath, entry.name)
			files[path.slice(root.length + 1)] = (await readFile(path)).toString('base64')
		}
		return files
	}

	it('leaves every file under kit/ unchanged when an Editor creates a View, updates the Workspace settings and changes the Product Kit file', async () => {
		const ctx = await kitFixture()
		// Build output beside the component sources.
		await write(join(ctx.root, 'kit', 'dist', 'kit.css'), '.button { color: red }\n')
		const before = await kitTree(ctx.root)
		expect(Object.keys(before)).toEqual(expect.arrayContaining(['kit/src/button.ts', 'kit/dist/kit.css', 'kit/package.json']))
		const session = http(ctx.app, HUMAN_EDITOR)

		expect(await session.createView({ id: '66666666-6666-4666-8666-666666666666', name: 'Checkout', spec: { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] } })).toMatchObject({ status: 'created' })
		const workspace = await ctx.app.readPointResource('workspace', 'workspace')
		if (workspace?.kind !== 'workspace') throw new Error('workspace')
		expect(await updateWorkspaceSettingsForHttp(session, { expectedRevision: workspace.revision, settings: { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: {} } })).toMatchObject({ status: 200 })
		expect(await composeProductKitForHttp(session, { expectedRevision: await revision(ctx.app), designSystems: ['@acme/design-system'], adapters: ['./uiux.js', '@acme/uiux-adapter'] })).toMatchObject({ status: 200 })
		expect(await updateProductKitForHttp(session, { expectedRevision: await revision(ctx.app), adapters: [{ moduleSpecifier: './uiux.js' }, { moduleSpecifier: '@acme/uiux-adapter' }], styles: ['./dist/kit.css'], themes: {} })).toMatchObject({ status: 200 })
		expect(await updateComponentRegistryForHttp(session, { expectedRevision: await revision(ctx.app), components: { button: { files: ['src/button.ts'], layer: 'design-system' } }, widgets: { Button: { component: 'button' } } })).toMatchObject({ status: 200 })

		expect(await kitTree(ctx.root)).toEqual(before)
	})
})
