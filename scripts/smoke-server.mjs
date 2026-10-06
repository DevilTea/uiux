#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect, createServer } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'

const host = '127.0.0.1'
// Keep the temporary Workspace under the repository so its Adapter resolves the
// repository's widget-core copy, while Nitro resolves its external from
// .output/server/node_modules. This deliberately exercises the production-only
// duplicate-module boundary that unit tests cannot reproduce.
const workspaceRoot = await mkdtemp(join(process.cwd(), '.uiux-server-smoke-'))
await mkdir(join(workspaceRoot, '.uiux'), { recursive: true })
await mkdir(join(workspaceRoot, 'adapters'), { recursive: true })
await writeFile(join(workspaceRoot, 'adapters', 'smoke.mjs'), [
	"import { createWidgetPlugin } from '@deviltea/widget-core'",
	'',
	"export const smokePlugin = createWidgetPlugin('SmokeWidget')",
	"  .description('Production Nitro adapter identity smoke plugin.')",
	'  .interfaces()',
	'  .done()',
	'',
	'export const manifest = {',
	"  id: 'production-identity-smoke',",
	"  apiVersion: '1',",
	'  widgetPlugins: [smokePlugin],',
	'  catalog: { widgets: { SmokeWidget: {} } },',
	'  renderers: [],',
	'  providers: [],',
	'  styles: [],',
	'  tokens: [],',
	'}',
	'',
	'export default manifest',
	'',
].join('\n'))
// The current product schema, from the package (the server opens it as `current`).
const { uiuxWorkspaceSchemaVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
await writeFile(join(workspaceRoot, '.uiux', 'workspace.json'), `${JSON.stringify({
	schemaVersion: uiuxWorkspaceSchemaVersion,
	i18n: { defaultLocale: 'en-US' },
	adapters: [{ moduleSpecifier: './adapters/smoke.mjs' }],
	viewports: {},
	themes: {},
}, null, 2)}\n`)

// Access rosters live in a private UIUX_HOME, never the developer's ~/.uiux. Tokens are created
// through the CLI exactly as a user would (accepted identity decision D17).
const uiuxHome = await mkdtemp(join(tmpdir(), 'uiux-smoke-home-'))
const cliBaseEnv = { ...process.env, UIUX_HOME: uiuxHome }
function uiuxCli(...args) {
	return execFileSync(process.execPath, ['bin/uiux.mjs', ...args], { encoding: 'utf8', env: cliBaseEnv })
}
uiuxCli('member', 'add', 'smoke-agent', '--kind', 'agent', '--role', 'editor', '--workspace', workspaceRoot)
const token = uiuxCli('token', 'create', '--member', 'smoke-agent', '--workspace', workspaceRoot).match(/uiux_t_\S+/u)?.[0]
if (!token) throw new Error('uiux token create printed no token.')
const auth = { authorization: `Bearer ${token}` }
// A token from another Workspace's roster must be refused.
const otherWorkspace = await mkdtemp(join(tmpdir(), 'uiux-smoke-other-'))
uiuxCli('init', '--workspace', otherWorkspace)
uiuxCli('member', 'add', 'other-agent', '--kind', 'agent', '--role', 'editor', '--workspace', otherWorkspace)
const foreignToken = uiuxCli('token', 'create', '--member', 'other-agent', '--workspace', otherWorkspace).match(/uiux_t_\S+/u)?.[0]

const probe = createServer()
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, resolve) })
const address = probe.address()
if (!address || typeof address === 'string') throw new Error('Could not select a local port for the Nitro smoke check.')
const port = address.port
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))

const server = spawn(process.execPath, ['.output/server/index.mjs'], {
	stdio: ['ignore', 'pipe', 'pipe'],
	env: {
		...process.env,
		UIUX_HOME: uiuxHome,
		HOST: host,
		PORT: String(port),
		NITRO_HOST: host,
		NITRO_PORT: String(port),
		UIUX_WORKSPACE_ROOT: workspaceRoot,
	},
})
let serverOutput = ''
server.stdout.setEncoding('utf8').on('data', chunk => serverOutput += chunk)
server.stderr.setEncoding('utf8').on('data', chunk => serverOutput += chunk)

try {
	const deadline = Date.now() + 15_000
	let health
	while (Date.now() < deadline) {
		if (server.exitCode !== null) throw new Error(`Nitro server exited before becoming ready.\n${serverOutput}`)
		try { health = await fetch(`http://${host}:${port}/api/health`); break }
		catch { await new Promise(resolve => setTimeout(resolve, 150)) }
	}
	if (!health) throw new Error(`Nitro server did not become ready within 15 seconds.\n${serverOutput}`)
	if (health.status !== 200 || JSON.stringify(await health.json()) !== JSON.stringify({ status: 'ok' }))
		throw new Error('GET /api/health returned an unexpected response.')

	const anonymous = await fetch(`http://${host}:${port}/api/resources/workspace/workspace`)
	if (anonymous.status !== 401 || (await anonymous.json()).code !== 'auth.required')
		throw new Error(`An unauthenticated /api read returned HTTP ${anonymous.status}, expected 401 auth.required.`)
	const mcpInit = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } })
	const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
	const anonymousMcp = await fetch(`http://${host}:${port}/mcp`, { method: 'POST', headers: mcpHeaders, body: mcpInit })
	if (anonymousMcp.status !== 401 || anonymousMcp.headers.get('www-authenticate') !== 'Bearer realm="uiux"')
		throw new Error(`/mcp without a token returned HTTP ${anonymousMcp.status}, expected 401 with WWW-Authenticate.`)
	const foreignMcp = await fetch(`http://${host}:${port}/mcp`, { method: 'POST', headers: { ...mcpHeaders, authorization: `Bearer ${foreignToken}` }, body: mcpInit })
	if (foreignMcp.status !== 401 || !(await foreignMcp.json()).message?.includes('belongs to roster'))
		throw new Error(`/mcp with another Workspace's token returned HTTP ${foreignMcp.status}, expected 401 naming the other roster.`)
	const tokenMcp = await fetch(`http://${host}:${port}/mcp`, { method: 'POST', headers: { ...mcpHeaders, ...auth }, body: mcpInit })
	if (tokenMcp.status !== 200) throw new Error(`/mcp with a CLI-created token returned HTTP ${tokenMcp.status}.`)
	const wellKnown = await fetch(`http://${host}:${port}/.well-known/oauth-authorization-server`)
	if (wellKnown.status !== 404 || !wellKnown.headers.get('content-type')?.includes('application/json'))
		throw new Error(`/.well-known/* returned HTTP ${wellKnown.status}, expected a JSON 404.`)

	const workspace = await fetch(`http://${host}:${port}/api/resources/workspace/workspace`, { headers: auth })
	if (workspace.status !== 200) throw new Error(`Selected Workspace route returned HTTP ${workspace.status}.`)
	const body = await workspace.json()
	if (body.resource?.schemaVersion !== uiuxWorkspaceSchemaVersion || body.inspection?.state !== 'current')
		throw new Error(`Selected Workspace route returned an unexpected body: ${JSON.stringify(body)}`)

	const adapters = await fetch(`http://${host}:${port}/api/preview/adapters`, { headers: auth })
	if (adapters.status !== 200) throw new Error(`Preview adapters route returned HTTP ${adapters.status}.`)
	const adapterBody = await adapters.json()
	if (adapterBody.state !== 'valid' || adapterBody.summaries?.[0]?.adapterId !== 'production-identity-smoke' || !adapterBody.bundleUrl)
		throw new Error(`Production Nitro failed to resolve a Workspace Adapter created by the repository widget-core runtime: ${JSON.stringify(adapterBody)}`)

	const runtime = await fetch(new URL(adapterBody.bundleUrl, `http://${host}:${port}/`), { headers: auth })
	if (!runtime.ok || !(await runtime.text()).includes('mountPreviewRuntime'))
		throw new Error('Preview runtime bundle was not materialized for the production identity smoke Adapter.')

	console.log(`Nitro smoke passed: health, 401 without a token and for another Workspace's token, a CLI-created token on /api and /mcp, selected Workspace API, and cross-module Workspace Adapter preview resolution against schemaVersion ${uiuxWorkspaceSchemaVersion}.`)
}
catch (error) {
	server.kill('SIGTERM')
	await rm(workspaceRoot, { recursive: true, force: true })
	await rm(otherWorkspace, { recursive: true, force: true })
	await rm(uiuxHome, { recursive: true, force: true })
	throw error
}
server.kill('SIGTERM')
await new Promise(resolve => server.exitCode !== null || server.signalCode !== null ? resolve() : server.once('exit', resolve))

try {
	await smokeLoopbackOnlyCli()
}
finally {
	await rm(workspaceRoot, { recursive: true, force: true })
	await rm(otherWorkspace, { recursive: true, force: true })
	await rm(uiuxHome, { recursive: true, force: true })
}

// `uiux dev` must bind loopback only, even when no HOST/NITRO_HOST is set (the LAN listener is not
// yet available), and must refuse an explicit non-loopback bind.
async function smokeLoopbackOnlyCli() {
	const cliEnv = { ...process.env, UIUX_HOME: uiuxHome }
	for (const name of ['HOST', 'NITRO_HOST', 'NITRO_PORT', 'NITRO_UNIX_SOCKET']) delete cliEnv[name]

	const refused = spawnSync(process.execPath, ['bin/uiux.mjs', 'dev', '--workspace', workspaceRoot], {
		encoding: 'utf8',
		env: { ...cliEnv, HOST: '0.0.0.0', PORT: String(port) },
		timeout: 15_000,
	})
	if (refused.status !== 2 || !refused.stderr.includes('the LAN listener is not yet available'))
		throw new Error(`uiux dev did not refuse HOST=0.0.0.0 (exit ${refused.status}).\n${refused.stdout}${refused.stderr}`)

	const cli = spawn(process.execPath, ['bin/uiux.mjs', 'dev', '--workspace', workspaceRoot], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...cliEnv, PORT: String(port) },
	})
	let cliOutput = ''
	cli.stdout.setEncoding('utf8').on('data', chunk => cliOutput += chunk)
	cli.stderr.setEncoding('utf8').on('data', chunk => cliOutput += chunk)
	try {
		const deadline = Date.now() + 15_000
		while (!cliOutput.includes('Listening on ')) {
			if (cli.exitCode !== null) throw new Error(`uiux dev exited before listening.\n${cliOutput}`)
			if (Date.now() > deadline) throw new Error(`uiux dev did not start within 15 seconds.\n${cliOutput}`)
			await new Promise(resolve => setTimeout(resolve, 100))
		}
		if (!cliOutput.includes(`Listening on http://127.0.0.1:${port}`))
			throw new Error(`uiux dev did not report a loopback listener.\n${cliOutput}`)

		const exposed = []
		const addresses = Object.values(networkInterfaces()).flat().filter(item => item && !item.internal)
		for (const item of addresses) {
			if (item.family === 'IPv6' && item.scopeid) continue // link-local needs a zone id
			if (await canConnect(item.address, port)) exposed.push(item.address)
		}
		if (exposed.length > 0)
			throw new Error(`uiux dev accepted connections on non-loopback addresses: ${exposed.join(', ')}`)

		const allowed = await request('GET', '/', {})
		if (allowed.status !== 200 || allowed.headers['x-frame-options'] !== 'SAMEORIGIN' || allowed.headers['content-security-policy'] !== 'frame-ancestors \'self\'')
			throw new Error(`Workbench HTML is missing frame-ancestors protection: ${JSON.stringify(allowed.headers)}`)
		const asset = allowed.body.match(/\/_nuxt\/[^"]+\.js/u)?.[0]
		const checks = [
			['GET', '/api/health', { host: `localhost:${port}` }, 200],
			['GET', '/api/health', { host: `rebind.attacker.test:${port}` }, 421],
			['GET', asset ?? '/_nuxt/missing.js', { host: `rebind.attacker.test:${port}` }, 421],
			['POST', '/mcp', { 'host': `rebind.attacker.test:${port}`, 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' }, 421],
			['POST', '/api/resources/list', { 'content-type': 'application/json', 'origin': 'https://attacker.test' }, 403],
			['POST', '/api/resources/list', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, 403],
			['POST', '/api/resources/list', { 'content-type': 'text/plain' }, 415],
			['POST', '/api/resources/list', { 'content-type': 'application/json' }, 401],
			['POST', '/api/resources/list', { 'content-type': 'application/json', ...auth }, 200],
			['POST', '/api/resources/list', { 'content-type': 'application/json', ...auth, 'origin': `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }, 200],
		]
		for (const [method, path, headers, expected] of checks) {
			const response = await request(method, path, headers, method === 'POST' ? JSON.stringify({ kinds: ['view'], limit: 1 }) : undefined)
			if (response.status !== expected)
				throw new Error(`${method} ${path} ${JSON.stringify(headers)} returned HTTP ${response.status}, expected ${expected}: ${response.body}`)
			if (Object.keys(response.headers).some(name => name.startsWith('access-control-')))
				throw new Error(`${method} ${path} sent CORS headers: ${JSON.stringify(response.headers)}`)
		}
		console.log(`Loopback smoke passed: uiux dev listens on 127.0.0.1 only (${addresses.length} non-loopback address(es) refused), refuses HOST=0.0.0.0, gates Host, Origin, Sec-Fetch-Site and Content-Type, and requires a credential.`)
	}
	finally {
		cli.kill('SIGTERM')
		await new Promise(resolve => cli.exitCode !== null || cli.signalCode !== null ? resolve() : cli.once('exit', resolve))
	}
}

function canConnect(address, targetPort) {
	return new Promise((resolve) => {
		const socket = connect({ host: address, port: targetPort, timeout: 1_000 })
		socket.once('connect', () => { socket.destroy(); resolve(true) })
		socket.once('timeout', () => { socket.destroy(); resolve(false) })
		socket.once('error', () => resolve(false))
	})
}

function request(method, path, headers, body) {
	return new Promise((resolve, reject) => {
		const req = httpRequest({ host, port, method, path, headers: { host: `${host}:${port}`, ...headers } }, (res) => {
			let text = ''
			res.setEncoding('utf8').on('data', chunk => text += chunk).on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
		})
		req.once('error', reject)
		req.end(body)
	})
}
