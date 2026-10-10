import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createLeaseManager } from '../src/application/access/leases'
import { AccessService } from '../src/server/access/service'
import { AccessStore } from '../src/server/access/store'
import {
	decodeDevHandoff,
	encodeDevHandoff,
	isLoopbackPeer,
	parseBindHost,
	parseConfiguredOrigin,
	resolveListenPort,
	resolveNetworkConfig,
	startupLines,
} from '../src/server/network-access'

const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'uiux.mjs')

describe('bind address (Clause 01a12500-a26d-744c-a5ef-4e05fea5c060)', () => {
	it('accepts only a loopback or a wildcard address', () => {
		expect(parseBindHost('127.0.0.1')).toEqual({ ok: true, value: { host: '127.0.0.1', wildcard: false } })
		expect(parseBindHost('::1')).toEqual({ ok: true, value: { host: '::1', wildcard: false } })
		expect(parseBindHost('[::1]')).toEqual({ ok: true, value: { host: '::1', wildcard: false } })
		expect(parseBindHost('LOCALHOST')).toEqual({ ok: true, value: { host: 'localhost', wildcard: false } })
		expect(parseBindHost('0.0.0.0')).toEqual({ ok: true, value: { host: '0.0.0.0', wildcard: true } })
		expect(parseBindHost('::')).toEqual({ ok: true, value: { host: '::', wildcard: true } })
		for (const host of ['192.168.1.20', '10.0.0.5', 'my-mac.local', '[::]', '127.0.0.2', 'fe80::1', ''])
			expect(parseBindHost(host), host).toMatchObject({ ok: false, message: expect.stringContaining('is not accepted') })
	})
})

describe('origin format (Clause 01a12500-a436-7368-8347-809e0176cfcc)', () => {
	it('normalizes http and https origins with an optional port', () => {
		expect(parseConfiguredOrigin('https://UIUX.Corp.Example')).toEqual({ ok: true, value: { origin: 'https://uiux.corp.example', scheme: 'https', hostname: 'uiux.corp.example', port: 443, defaultPort: true, loopback: false } })
		expect(parseConfiguredOrigin('https://uiux.corp.example:443/')).toMatchObject({ ok: true, value: { origin: 'https://uiux.corp.example', port: 443, defaultPort: true } })
		expect(parseConfiguredOrigin('http://10.0.0.5:3000')).toMatchObject({ ok: true, value: { origin: 'http://10.0.0.5:3000', port: 3000, defaultPort: false } })
		expect(parseConfiguredOrigin('http://[fd00::5]:3000')).toMatchObject({ ok: true, value: { hostname: '[fd00::5]', port: 3000 } })
		expect(parseConfiguredOrigin('http://localhost:8080')).toMatchObject({ ok: true, value: { loopback: true } })
	})

	it('refuses paths, queries, fragments, user information, other schemes and bad ports', () => {
		for (const raw of ['https://uiux.corp.example/uiux', 'https://uiux.corp.example/?x=1', 'https://uiux.corp.example?', 'https://uiux.corp.example#top', 'https://user:pw@uiux.corp.example', 'https://user@uiux.corp.example', 'ftp://uiux.corp.example', 'uiux.corp.example', '//uiux.corp.example', 'http://', 'http://a:0', 'http://a:65536', 'http://a\\b', 'http://a/./', ''])
			expect(parseConfiguredOrigin(raw), raw).toMatchObject({ ok: false })
	})

	it('refuses ambiguous origin sets and loopback collisions at startup', () => {
		const resolve = (origins: string[], host?: string) => resolveNetworkConfig({ ...(host ? { host } : {}), origins, port: 3000 })
		expect(resolve(['https://a.test', 'https://a.test'])).toMatchObject({ ok: false, message: expect.stringContaining('share the host and port') })
		expect(resolve(['http://a.test:8080', 'https://a.test:8080'])).toMatchObject({ ok: false, message: expect.stringContaining('share the host and port') })
		expect(resolve(['http://a.test', 'https://a.test'])).toMatchObject({ ok: false, message: expect.stringContaining('both use their scheme\'s default port') })
		expect(resolve(['https://a.test', 'http://a.test'])).toMatchObject({ ok: false })
		expect(resolve(['http://127.0.0.1:3000'])).toMatchObject({ ok: false, message: expect.stringContaining('already serves') })
		expect(resolve(['http://[::1]:3000'])).toMatchObject({ ok: false })
		expect(resolve(['http://localhost:3000'])).toMatchObject({ ok: false })
		// Same host on distinct non-default ports, or one default port, is not ambiguous.
		expect(resolve(['http://a.test:8080', 'https://a.test'])).toMatchObject({ ok: true })
		expect(resolve(['http://a.test:8080', 'http://a.test:8081'])).toMatchObject({ ok: true })
		expect(resolve(['http://localhost:8080'])).toMatchObject({ ok: true })
		expect(resolve(['not an origin'])).toMatchObject({ ok: false, message: expect.stringContaining('is not an origin') })
	})

	it('refuses a wildcard bind without an origin (Rule 01a12500-a9c5-74e6-868a-2a6f4a5f3315) and defaults to loopback', () => {
		expect(resolveNetworkConfig({ host: '0.0.0.0', origins: [], port: 3000 })).toMatchObject({ ok: false, message: expect.stringContaining('needs at least one --origin') })
		expect(resolveNetworkConfig({ host: '::', origins: [], port: 3000 })).toMatchObject({ ok: false })
		expect(resolveNetworkConfig({ origins: [], port: 3000 })).toEqual({ ok: true, value: { bindHost: '127.0.0.1', wildcard: false, origins: [] } })
		expect(resolveNetworkConfig({ host: '0.0.0.0', origins: ['http://10.0.0.5:3000'], port: 3000 })).toMatchObject({ ok: true, value: { bindHost: '0.0.0.0', wildcard: true } })
		// A loopback bind with origins: a reverse proxy on the same host.
		expect(resolveNetworkConfig({ origins: ['https://uiux.corp.example'], port: 3000 })).toMatchObject({ ok: true, value: { bindHost: '127.0.0.1', wildcard: false } })
	})

	it('round-trips the internal handoff and validates it again against the server port', () => {
		const handoff = encodeDevHandoff({ host: '0.0.0.0', origins: ['http://10.0.0.5:3000'] })
		expect(decodeDevHandoff(handoff, 3000)).toMatchObject({ ok: true, value: { bindHost: '0.0.0.0', origins: [{ origin: 'http://10.0.0.5:3000' }] } })
		expect(decodeDevHandoff(encodeDevHandoff({ origins: [] }), 3000)).toMatchObject({ ok: true, value: { bindHost: '127.0.0.1' } })
		expect(decodeDevHandoff(encodeDevHandoff({ host: '0.0.0.0', origins: [] }), 3000)).toMatchObject({ ok: false })
		expect(decodeDevHandoff(encodeDevHandoff({ host: '10.0.0.5', origins: ['http://10.0.0.5:3000'] }), 3000)).toMatchObject({ ok: false })
		expect(decodeDevHandoff('{', 3000)).toMatchObject({ ok: false })
		expect(decodeDevHandoff('{"host":1,"origins":[]}', 3000)).toMatchObject({ ok: false })
		expect(resolveListenPort({})).toBe(3000)
		expect(resolveListenPort({ PORT: '4000' })).toBe(4000)
		expect(resolveListenPort({ PORT: '4000', NITRO_PORT: '5000' })).toBe(5000)
	})

	it('recognizes loopback peers', () => {
		for (const peer of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', undefined]) expect(isLoopbackPeer(peer), String(peer)).toBe(true)
		for (const peer of ['10.0.0.5', '::ffff:10.0.0.5', 'fe80::1', '128.0.0.1', '::']) expect(isLoopbackPeer(peer), peer).toBe(false)
	})
})

describe('startup output (Rules 01a12500-b4af-7446-a66e-40de3db3dac2, 01a12500-b2db-7083-973d-1bf90a859a5b, 01a12515-9c61-7916-a0d0-4bcf2537dfc9)', () => {
	it('prints the loopback URL, each configured origin, and a plaintext warning for each http network origin', () => {
		const network = resolveNetworkConfig({ host: '0.0.0.0', origins: ['https://uiux.corp.example', 'http://10.0.0.5:3000', 'http://localhost:8080'], port: 3000 })
		if (!network.ok) throw new Error(network.message)
		const lines = startupLines('http://127.0.0.1:3000', network.value)
		expect(lines.slice(0, 4)).toEqual([
			'uiux: loopback URL http://127.0.0.1:3000',
			'uiux: configured origin https://uiux.corp.example',
			'uiux: configured origin http://10.0.0.5:3000',
			'uiux: configured origin http://localhost:8080',
		])
		const warnings = lines.filter(line => line.startsWith('uiux: warning:'))
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain('http://10.0.0.5:3000 is plain HTTP. Sign-in links, session cookies and Tokens cross the network in clear text')
		const loopbackOnly = resolveNetworkConfig({ origins: [], port: 3000 })
		if (!loopbackOnly.ok) throw new Error(loopbackOnly.message)
		expect(startupLines('http://127.0.0.1:3000', loopbackOnly.value)).toEqual(['uiux: loopback URL http://127.0.0.1:3000'])
	})

	describe('first-run sign-in links', () => {
		let base: string
		beforeAll(async () => {
			base = await realpath(await mkdtemp(join(tmpdir(), 'uiux-network-bootstrap-')))
		})
		afterAll(async () => { await rm(base, { recursive: true, force: true }) })

		it('prints one link per origin, all carrying the same single-use invite', async () => {
			const workspace = join(base, 'design')
			await mkdir(join(workspace, '.uiux'), { recursive: true })
			await writeFile(join(workspace, '.uiux', 'workspace.json'), '{}\n')
			const store = (await AccessStore.open({ workspaceRoot: workspace, home: join(base, 'home'), create: true }))!
			const service = new AccessService({ store, leases: createLeaseManager() })
			const origins = ['http://127.0.0.1:3000', 'https://uiux.corp.example', 'http://10.0.0.5:3000']
			const banner = await service.bootstrap(origins)
			const links = (banner ?? []).map(line => line.trim()).filter(line => line.includes('/login#'))
			expect(links.map(link => link.split('/login#')[0])).toEqual(origins)
			expect(new Set(links.map(link => link.split('#')[1])).size).toBe(1)
			expect(banner?.join('\n')).toContain('one single-use invite')
		})
	})
})

describe('uiux dev refusals', () => {
	let base: string
	let workspace: string
	beforeAll(async () => {
		base = await realpath(await mkdtemp(join(tmpdir(), 'uiux-network-cli-')))
		workspace = join(base, 'design')
		await mkdir(join(workspace, '.uiux'), { recursive: true })
		await writeFile(join(workspace, '.uiux', 'workspace.json'), '{}\n')
	})
	afterAll(async () => { await rm(base, { recursive: true, force: true }) })

	/** Runs `uiux dev`, which must refuse before it starts any server. */
	function refused(args: readonly string[], env: Readonly<Record<string, string>> = {}) {
		const childEnv: Record<string, string | undefined> = { ...process.env, UIUX_HOME: join(base, 'home'), PORT: '3999', ...env }
		for (const name of ['HOST', 'NITRO_HOST', 'NITRO_PORT', 'NITRO_SSL_CERT', 'NITRO_SSL_KEY']) if (!(name in env)) delete childEnv[name]
		const result = spawnSync(process.execPath, [CLI, 'dev', '--workspace', workspace, ...args], { encoding: 'utf8', env: childEnv, timeout: 20_000 })
		expect(result.stdout).not.toContain('serving Workspace')
		return { status: result.status, stderr: result.stderr }
	}

	it('refuses a wildcard bind without an origin', () => {
		for (const host of ['0.0.0.0', '::']) {
			const result = refused(['--host', host])
			expect(result.status).toBe(2)
			expect(result.stderr).toContain('needs at least one --origin')
		}
	})

	it('refuses a --host that is neither loopback nor wildcard, and a non-loopback HOST or NITRO_HOST', () => {
		expect(refused(['--host', '192.168.1.20', '--origin', 'http://192.168.1.20:3999'])).toMatchObject({ status: 2, stderr: expect.stringContaining('is not accepted') })
		expect(refused([], { HOST: '0.0.0.0' })).toMatchObject({ status: 2, stderr: expect.stringContaining('takes its bind address from --host only') })
		expect(refused(['--origin', 'http://10.0.0.5:3999'], { NITRO_HOST: '10.0.0.5' })).toMatchObject({ status: 2 })
	})

	it('refuses invalid, duplicate, ambiguous and loopback-colliding origins', () => {
		for (const origins of [
			['https://uiux.corp.example/uiux'],
			['uiux.corp.example'],
			['https://uiux.corp.example', 'https://uiux.corp.example'],
			['http://uiux.corp.example', 'https://uiux.corp.example'],
			['http://127.0.0.1:3999'],
		]) {
			const result = refused(['--host', '0.0.0.0', ...origins.flatMap(origin => ['--origin', origin])])
			expect(result.status, origins.join(' ')).toBe(2)
			expect(result.stderr).toMatch(/^uiux: --origin /mu)
		}
	})

	it('refuses NITRO_SSL_CERT and NITRO_SSL_KEY: UIUX serves plain HTTP only', () => {
		expect(refused([], { NITRO_SSL_CERT: 'cert', NITRO_SSL_KEY: 'key' })).toMatchObject({ status: 2, stderr: expect.stringContaining('UIUX serves plain HTTP only') })
	})
})
