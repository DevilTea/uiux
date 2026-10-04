#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
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
finally {
	server.kill('SIGTERM')
	await rm(workspaceRoot, { recursive: true, force: true })
}
