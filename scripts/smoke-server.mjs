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
// Access rosters live in a private UIUX_HOME, never the developer's ~/.uiux.
const uiuxHome = await mkdtemp(join(tmpdir(), 'uiux-smoke-home-'))
const otherWorkspace = await mkdtemp(join(tmpdir(), 'uiux-smoke-other-'))

// Every child server is stopped, and has exited, before the temporary directories are removed: a
// server still shutting down (the history recorder's shutdown boundary) writes into the Workspace,
// and removing it under that writer fails with ENOTEMPTY and masks the error that stopped the run.
const children = new Set()
let cleanupPromise
function cleanup() {
	cleanupPromise ??= (async () => {
		await Promise.all([...children].map(stopChild))
		const removed = await Promise.allSettled([workspaceRoot, otherWorkspace, uiuxHome].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 5 })))
		const failures = removed.filter(result => result.status === 'rejected').map(result => result.reason)
		if (failures.length > 0) throw new AggregateError(failures, 'Server smoke cleanup could not remove its temporary directories.')
	})()
	return cleanupPromise
}
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
	process.once(signal, () => {
		console.error(`Server smoke interrupted by ${signal}; cleaning up.`)
		cleanup().catch(error => console.error(error)).finally(() => process.exit(code))
	})
}

let port
let auth
let failed = false
try {
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

	// Tokens are created through the CLI exactly as a user would (accepted identity decision D17).
	const cliBaseEnv = { ...process.env, UIUX_HOME: uiuxHome }
	const uiuxCli = (...args) => execFileSync(process.execPath, ['bin/uiux.mjs', ...args], { encoding: 'utf8', env: cliBaseEnv })
	uiuxCli('member', 'add', 'smoke-agent', '--kind', 'agent', '--role', 'editor', '--workspace', workspaceRoot)
	const token = uiuxCli('token', 'create', '--member', 'smoke-agent', '--workspace', workspaceRoot).match(/uiux_t_\S+/u)?.[0]
	if (!token) throw new Error('uiux token create printed no token.')
	auth = { authorization: `Bearer ${token}` }
	// A token from another Workspace's roster must be refused.
	uiuxCli('init', '--workspace', otherWorkspace)
	uiuxCli('member', 'add', 'other-agent', '--kind', 'agent', '--role', 'editor', '--workspace', otherWorkspace)
	const foreignToken = uiuxCli('token', 'create', '--member', 'other-agent', '--workspace', otherWorkspace).match(/uiux_t_\S+/u)?.[0]

	const probe = createServer()
	await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, host, resolve) })
	const address = probe.address()
	if (!address || typeof address === 'string') throw new Error('Could not select a local port for the Nitro smoke check.')
	port = address.port
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
	children.add(server)
	let serverOutput = ''
	server.stdout.setEncoding('utf8').on('data', chunk => serverOutput += chunk)
	server.stderr.setEncoding('utf8').on('data', chunk => serverOutput += chunk)

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

	const historyStarted = Date.now()
	await smokeHistory({ origin: `http://${host}:${port}`, auth, mcpHeaders })
	console.log(`History smoke passed in ${Date.now() - historyStarted} ms: an Agent's MCP task ended by release_lock is one autosave, a Checkpoint, its diff against current naming only the changed View, a restore naming restoredFrom, release_lock recording nothing more, and an on-disk edit recorded as an external version.`)

	// `uiux dev` below reuses the port, so this server must have exited first.
	await stopChild(server)
	await smokeLoopbackOnlyCli()
}
catch (error) {
	failed = true
	throw error
}
finally {
	// A cleanup failure must not replace the error that stopped the run.
	await cleanup().catch((error) => {
		if (!failed) throw error
		console.error('Server smoke cleanup also failed:', error)
	})
}

/** Sends SIGTERM and resolves once the child has exited (SIGKILL after a 10 s grace period). */
async function stopChild(child) {
	if (child.exitCode !== null || child.signalCode !== null) return
	const exited = new Promise(resolve => child.once('exit', resolve))
	child.kill('SIGTERM')
	const forceKill = setTimeout(() => child.kill('SIGKILL'), 10_000)
	await exited
	clearTimeout(forceKill)
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
	children.add(cli)
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
		await stopChild(cli)
	}
}

// Version history end to end, through the public HTTP and MCP surfaces only (issue #132). Every
// wait polls a public read with a bounded deadline; nothing sleeps for a fixed time.
async function smokeHistory({ origin, auth, mcpHeaders }) {
	const VIEW_ID = '0b11e2e0-0000-4000-8000-00000000b011'
	const viewSpec = intent => ({ intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] })
	let rpcId = 100
	async function callTool(name, args) {
		const response = await fetch(`${origin}/mcp`, {
			method: 'POST',
			headers: { ...mcpHeaders, ...auth, 'mcp-protocol-version': '2025-06-18' },
			body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
		})
		const text = await response.text()
		if (response.status !== 200) throw new Error(`MCP ${name} returned HTTP ${response.status}: ${text}`)
		// A stateless Streamable HTTP response is either JSON or one SSE event carrying the JSON-RPC answer.
		const payload = response.headers.get('content-type')?.includes('text/event-stream')
			? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).at(-1)
			: text
		const message = JSON.parse(payload ?? 'null')
		if (!message?.result || message.result.isError) throw new Error(`MCP ${name} failed: ${payload}`)
		return message.result.structuredContent
	}
	async function api(method, path, body) {
		const response = await fetch(`${origin}${path}`, {
			method,
			headers: { ...auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
		return { status: response.status, body: await response.json() }
	}
	async function versions() {
		const listed = await api('GET', '/api/history/versions?limit=200')
		if (listed.status !== 200) throw new Error(`GET /api/history/versions returned HTTP ${listed.status}: ${JSON.stringify(listed.body)}`)
		return listed.body.versions
	}
	async function waitFor(label, probe, timeoutMs = 10_000) {
		const deadline = Date.now() + timeoutMs
		for (;;) {
			const value = await probe()
			if (value) return value
			if (Date.now() > deadline) throw new Error(`History smoke timed out after ${timeoutMs} ms waiting for ${label}.\n${JSON.stringify(await versions(), null, 2)}`)
			await new Promise(resolve => setTimeout(resolve, 50))
		}
	}
	async function viewRevision() {
		const read = await api('GET', `/api/resources/view/${VIEW_ID}`)
		if (read.status !== 200 || !read.body.revision) throw new Error(`Reading the smoke View returned HTTP ${read.status}: ${JSON.stringify(read.body)}`)
		return read.body.revision
	}
	const isSmokeAgent = actor => actor?.type === 'agent' && actor.displayName === 'smoke-agent'

	// The recorder starts in the background: its Baseline Checkpoint marks it ready.
	await waitFor('the Baseline Checkpoint', async () => (await versions()).some(version => version.type === 'checkpoint' && version.actor?.id === 'system:baseline'))

	// 1. An Agent's task over /mcp (Bearer token), ended by release_lock, is one autosave.
	await callTool('create_view', { id: VIEW_ID, name: 'History smoke', spec: viewSpec('first') })
	await callTool('update_view_spec', { viewId: VIEW_ID, expectedRevision: await viewRevision(), spec: viewSpec('second') })
	const released = await callTool('release_lock', {})
	if (released?.status !== 'released') throw new Error(`release_lock answered ${JSON.stringify(released)}.`)
	const autosave = await waitFor('the Agent autosave', async () => (await versions()).find(version => version.type === 'autosave' && isSmokeAgent(version.actor)))
	if (!autosave.summary.some(change => change.kind === 'view' && change.key === VIEW_ID && change.status === 'added'))
		throw new Error(`The Agent autosave does not record the new View: ${JSON.stringify(autosave)}`)
	const agentAutosaves = (await versions()).filter(version => version.type === 'autosave' && isSmokeAgent(version.actor))
	if (agentAutosaves.length !== 1) throw new Error(`One Agent task produced ${agentAutosaves.length} autosaves, expected 1.`)

	// 2. A Checkpoint names the current state.
	const checkpoint = await callTool('create_checkpoint', { name: 'Smoke checkpoint' })
	if (checkpoint?.status !== 'created' || !checkpoint.versionId) throw new Error(`create_checkpoint answered ${JSON.stringify(checkpoint)}.`)

	// 3. After one more write, the Checkpoint differs from current in that View only.
	await callTool('update_view_spec', { viewId: VIEW_ID, expectedRevision: await viewRevision(), spec: viewSpec('after the checkpoint') })
	const diff = await api('GET', `/api/history/diff?from=${checkpoint.versionId}&to=current&detail=semantic&resource=view:${VIEW_ID}`)
	if (diff.status !== 200 || diff.body.status !== 'compared')
		throw new Error(`GET /api/history/diff returned HTTP ${diff.status}: ${JSON.stringify(diff.body)}`)
	const changed = diff.body.summary.filter(item => item.status !== 'unchanged')
	if (changed.length !== 1 || changed[0].kind !== 'view' || changed[0].key !== VIEW_ID || changed[0].status !== 'modified' || !diff.body.changes?.length)
		throw new Error(`The Checkpoint-to-current diff is not the one modified View: ${JSON.stringify(diff.body)}`)
	// The filter above restricts the summary to that View, so it cannot show that nothing else
	// changed; the unfiltered summary over every versioned resource must name that View alone.
	const whole = await api('GET', `/api/history/diff?from=${checkpoint.versionId}&to=current&detail=summary`)
	if (whole.status !== 200 || whole.body.status !== 'compared')
		throw new Error(`GET /api/history/diff (unfiltered) returned HTTP ${whole.status}: ${JSON.stringify(whole.body)}`)
	if (!whole.body.summary.some(item => item.kind === 'workspace' && item.status === 'unchanged'))
		throw new Error(`The unfiltered diff does not list the unchanged Workspace settings: ${JSON.stringify(whole.body.summary)}`)
	const wholeChanged = whole.body.summary.filter(item => item.status !== 'unchanged')
	if (wholeChanged.length !== 1 || wholeChanged[0].kind !== 'view' || wholeChanged[0].key !== VIEW_ID || wholeChanged[0].status !== 'modified')
		throw new Error(`The unfiltered Checkpoint-to-current diff changes more than the one View: ${JSON.stringify(whole.body.summary)}`)

	// 4. Restoring the View from the Checkpoint (expectedRevision CAS) is its own version naming restoredFrom.
	const stale = await api('POST', `/api/history/versions/${checkpoint.versionId}/restore`, { resource: { kind: 'view', key: VIEW_ID }, expectedRevision: 'r_stale' })
	if (stale.status !== 409 || stale.body.status !== 'conflict') throw new Error(`A restore with a stale expectedRevision returned HTTP ${stale.status}: ${JSON.stringify(stale.body)}`)
	const restored = await api('POST', `/api/history/versions/${checkpoint.versionId}/restore`, { resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision() })
	if (restored.status !== 200 || restored.body.status !== 'updated' || restored.body.restoredFrom !== checkpoint.versionId)
		throw new Error(`The restore returned HTTP ${restored.status}: ${JSON.stringify(restored.body)}`)
	if ((await api('GET', `/api/resources/view/${VIEW_ID}`)).body.resource?.spec?.intent !== 'second')
		throw new Error('The restored View does not hold the Checkpoint content.')
	await waitFor('the restore version', async () => (await versions()).some(version => version.restoredFrom === checkpoint.versionId && version.summary.some(change => change.key === VIEW_ID)))
	// The restore closed its own autosave, so ending the task now releases the View lease the Agent's
	// update_view_spec took and records nothing (release_lock answers only after its history boundary).
	const versionsBeforeRelease = (await versions()).length
	const releasedAfterRestore = await callTool('release_lock', {})
	if (releasedAfterRestore?.status !== 'released' || JSON.stringify(releasedAfterRestore.released) !== JSON.stringify([{ kind: 'view', key: VIEW_ID }]))
		throw new Error(`release_lock after the restore answered ${JSON.stringify(releasedAfterRestore)}, expected the View lease.`)
	if ((await versions()).length !== versionsBeforeRelease)
		throw new Error('release_lock with no open autosave recorded a version.')

	// 5. An edit made on disk while the server runs is recorded as an external version at the next boundary.
	const viewPath = join(workspaceRoot, 'views', `${VIEW_ID}.view.json`)
	const onDisk = JSON.parse(await readFile(viewPath, 'utf8'))
	await writeFile(viewPath, `${JSON.stringify({ ...onDisk, name: 'Edited outside UIUX' }, null, 2)}\n`)
	const boundary = await callTool('create_checkpoint', { name: 'After an outside edit' })
	const timeline = await waitFor('the external version', async () => {
		const listed = await versions()
		return listed.some(version => version.type === 'external') ? listed : undefined
	})
	const external = timeline.find(version => version.type === 'external')
	if (external.actor?.type !== 'external' || !external.summary.some(change => change.kind === 'view' && change.key === VIEW_ID))
		throw new Error(`The external version does not record the outside View edit: ${JSON.stringify(external)}`)
	const order = timeline.map(version => version.id)
	const boundaryAt = order.indexOf(boundary?.versionId)
	const externalAt = order.indexOf(external.id)
	if (boundaryAt < 0 || externalAt < 0)
		throw new Error(`The timeline does not list both the Checkpoint ${boundary?.versionId} and the external version ${external.id}: ${JSON.stringify(order)}`)
	// The list is newest first: the Checkpoint that detected the edit comes before the external version.
	if (boundaryAt > externalAt)
		throw new Error('The external version is not recorded before the Checkpoint that detected it.')
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
