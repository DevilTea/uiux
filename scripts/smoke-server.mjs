#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { connect, createServer } from 'node:net'
import { networkInterfaces } from 'node:os'
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
await writeFile(join(workspaceRoot, '.uiux', 'workspace.json'), `${JSON.stringify({
	schemaVersion: 1,
	i18n: { defaultLocale: 'en-US' },
	adapters: [{ moduleSpecifier: './adapters/smoke.mjs' }],
	viewports: {},
	themes: {},
}, null, 2)}\n`)

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

	const workspace = await fetch(`http://${host}:${port}/api/resources/workspace/workspace`)
	if (workspace.status !== 200) throw new Error(`Selected Workspace route returned HTTP ${workspace.status}.`)
	const body = await workspace.json()
	if (body.resource?.schemaVersion !== 1 || body.inspection?.state !== 'current')
		throw new Error(`Selected Workspace route returned an unexpected body: ${JSON.stringify(body)}`)

	const adapters = await fetch(`http://${host}:${port}/api/preview/adapters`)
	if (adapters.status !== 200) throw new Error(`Preview adapters route returned HTTP ${adapters.status}.`)
	const adapterBody = await adapters.json()
	if (adapterBody.state !== 'valid' || adapterBody.summaries?.[0]?.adapterId !== 'production-identity-smoke' || !adapterBody.bundleUrl)
		throw new Error(`Production Nitro failed to resolve a Workspace Adapter created by the repository widget-core runtime: ${JSON.stringify(adapterBody)}`)

	const runtime = await fetch(new URL(adapterBody.bundleUrl, `http://${host}:${port}/`))
	if (!runtime.ok || !(await runtime.text()).includes('mountPreviewRuntime'))
		throw new Error('Preview runtime bundle was not materialized for the production identity smoke Adapter.')

	console.log('Nitro smoke passed: health, selected Workspace API, and cross-module Workspace Adapter preview resolution are live against schemaVersion 1.')
}
catch (error) {
	server.kill('SIGTERM')
	await rm(workspaceRoot, { recursive: true, force: true })
	throw error
}
server.kill('SIGTERM')
await new Promise(resolve => server.exitCode !== null || server.signalCode !== null ? resolve() : server.once('exit', resolve))

try {
	await smokeLoopbackOnlyCli()
}
finally {
	await rm(workspaceRoot, { recursive: true, force: true })
}

// `uiux dev` must bind loopback only, even when no HOST/NITRO_HOST is set (Part 1 item 12), and
// must refuse an explicit non-loopback bind instead of exposing unauthenticated /api and /mcp.
async function smokeLoopbackOnlyCli() {
	const cliEnv = { ...process.env }
	for (const name of ['HOST', 'NITRO_HOST', 'NITRO_PORT', 'NITRO_UNIX_SOCKET']) delete cliEnv[name]

	const refused = spawnSync(process.execPath, ['bin/uiux.mjs', 'dev', '--workspace', workspaceRoot], {
		encoding: 'utf8',
		env: { ...cliEnv, HOST: '0.0.0.0', PORT: String(port) },
		timeout: 15_000,
	})
	if (refused.status !== 2 || !refused.stderr.includes('LAN exposure requires authentication, which is not yet available'))
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
			['POST', '/api/resources/list', { 'content-type': 'application/json' }, 200],
			['POST', '/api/resources/list', { 'content-type': 'application/json', 'origin': `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }, 200],
		]
		for (const [method, path, headers, expected] of checks) {
			const response = await request(method, path, headers, method === 'POST' ? JSON.stringify({ kinds: ['view'], limit: 1 }) : undefined)
			if (response.status !== expected)
				throw new Error(`${method} ${path} ${JSON.stringify(headers)} returned HTTP ${response.status}, expected ${expected}: ${response.body}`)
			if (Object.keys(response.headers).some(name => name.startsWith('access-control-')))
				throw new Error(`${method} ${path} sent CORS headers: ${JSON.stringify(response.headers)}`)
		}
		console.log(`Loopback smoke passed: uiux dev listens on 127.0.0.1 only (${addresses.length} non-loopback address(es) refused), refuses HOST=0.0.0.0, and gates Host, Origin, Sec-Fetch-Site and Content-Type.`)
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
