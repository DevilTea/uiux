#!/usr/bin/env node

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const host = '127.0.0.1'
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'uiux-package-smoke-'))
const packDirectory = join(temporaryDirectory, 'pack')
const installDirectory = join(temporaryDirectory, 'install')
const workspaceDirectory = join(temporaryDirectory, 'workspace')

async function selectPort() {
	const probe = createServer()
	await new Promise((resolve, reject) => {
		probe.once('error', reject)
		probe.listen(0, host, resolve)
	})
	const address = probe.address()
	if (!address || typeof address === 'string')
		throw new Error('Could not select a local port for the package smoke check.')
	const port = address.port
	await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
	return port
}

async function waitForHealth(port, server, output) {
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		if (server.exitCode !== null)
			throw new Error(`Packed UIUX CLI exited before becoming ready.\n${output()}`)
		try { return await fetch(`http://${host}:${port}/api/health`) }
		catch { await new Promise(resolve => setTimeout(resolve, 150)) }
	}
	throw new Error(`Packed UIUX server did not become ready within 15 seconds.\n${output()}`)
}

async function stopServer(server) {
	if (server.exitCode !== null) return
	server.kill('SIGTERM')
	const exited = await Promise.race([
		new Promise(resolve => server.once('exit', () => resolve(true))),
		new Promise(resolve => setTimeout(() => resolve(false), 3_000)),
	])
	if (!exited) {
		server.kill('SIGKILL')
		throw new Error('Packed uiux dev did not terminate after SIGTERM; CLI signal forwarding is broken.')
	}
}

try {
	await mkdir(packDirectory, { recursive: true })
	await mkdir(installDirectory, { recursive: true })
	await mkdir(join(workspaceDirectory, '.uiux'), { recursive: true })
	await writeFile(join(workspaceDirectory, '.uiux', 'workspace.json'), `${JSON.stringify({
		schemaVersion: 1,
		i18n: { defaultLocale: 'en-US' },
		adapters: [],
		viewports: {},
		themes: {},
	}, null, 2)}\n`)
	const viewId = '11111111-1111-4111-8111-111111111111'
	await mkdir(join(workspaceDirectory, 'views'), { recursive: true })
	await writeFile(join(workspaceDirectory, 'views', `${viewId}.view.json`), `${JSON.stringify({
		id: viewId,
		name: 'Package smoke view',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}, null, 2)}\n`)

	const packedFilename = execFileSync('npm', ['pack', '--pack-destination', packDirectory, '--silent'], { encoding: 'utf8' }).trim().split('\n').at(-1)
	if (!packedFilename) throw new Error('npm pack did not report a tarball filename.')

	const tarballPath = join(packDirectory, packedFilename)
	await writeFile(join(installDirectory, 'package.json'), JSON.stringify({ private: true }, null, 2))
	execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], { cwd: installDirectory, stdio: 'pipe' })

	const packageRoot = join(installDirectory, 'node_modules', '@deviltea', 'uiux')
	const installedPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
	const cliPath = join(installDirectory, 'node_modules', '.bin', 'uiux')
	const helpOutput = execFileSync(cliPath, ['--help'], { encoding: 'utf8' })
	if (!helpOutput.includes('dev --workspace <dir>'))
		throw new Error('Packed CLI help did not expose the selected-Workspace dev command.')
	const versionOutput = execFileSync(cliPath, ['--version'], { encoding: 'utf8' }).trim()
	if (versionOutput !== `uiux ${installedPackage.version}`)
		throw new Error(`Packed CLI version mismatch: ${versionOutput}`)

	const port = await selectPort()
	const server = spawn(cliPath, ['dev', '--workspace', workspaceDirectory], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			HOST: host,
			PORT: String(port),
			NITRO_HOST: host,
			NITRO_PORT: String(port),
		},
	})
	let serverOutput = ''
	server.stdout.setEncoding('utf8').on('data', chunk => serverOutput += chunk)
	server.stderr.setEncoding('utf8').on('data', chunk => serverOutput += chunk)

	let client
	try {
		const health = await waitForHealth(port, server, () => serverOutput)
		if (health.status !== 200 || JSON.stringify(await health.json()) !== JSON.stringify({ status: 'ok' }))
			throw new Error('Packed CLI health endpoint did not return the expected response.')

		const workspaceResponse = await fetch(`http://${host}:${port}/api/resources/workspace/workspace`)
		if (workspaceResponse.status !== 200)
			throw new Error(`Packed selected-Workspace API returned HTTP ${workspaceResponse.status}.`)
		const workspaceRead = await workspaceResponse.json()
		if (workspaceRead.kind !== 'workspace' || workspaceRead.resource?.schemaVersion !== 1 || workspaceRead.inspection?.state !== 'current')
			throw new Error(`Packed selected-Workspace API returned an unexpected body: ${JSON.stringify(workspaceRead)}`)

		const listResponse = await fetch(`http://${host}:${port}/api/resources/list`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kinds: ['view'], limit: 10 }),
		})
		if (listResponse.status !== 200) throw new Error(`Packed resource-list API returned HTTP ${listResponse.status}.`)
		const listPage = await listResponse.json()
		if (listPage.items?.length !== 1 || listPage.items[0]?.key !== viewId)
			throw new Error(`Packed resource-list API returned an unexpected page: ${JSON.stringify(listPage)}`)

		const searchResponse = await fetch(`http://${host}:${port}/api/resources/search`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ query: 'package smoke', kinds: ['view'], limit: 10 }),
		})
		if (searchResponse.status !== 200) throw new Error(`Packed resource-search API returned HTTP ${searchResponse.status}.`)
		const searchPage = await searchResponse.json()
		if (searchPage.items?.length !== 1 || searchPage.items[0]?.key !== viewId)
			throw new Error(`Packed resource-search API returned an unexpected page: ${JSON.stringify(searchPage)}`)

		client = new Client({ name: 'uiux-package-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`))
		await client.connect(transport)
		const mcpRead = await client.readResource({ uri: 'uiux://workspace' })
		const content = mcpRead.contents[0]
		const mcpWorkspace = content && 'text' in content ? JSON.parse(content.text) : undefined
		if (mcpWorkspace?.revision !== workspaceRead.revision || mcpWorkspace?.resource?.schemaVersion !== 1)
			throw new Error('Live MCP did not read the same selected Workspace revision as HTTP.')
		const mcpList = await client.callTool({ name: 'list_resources', arguments: { kinds: ['view'], limit: 10 } })
		const mcpListPage = mcpList.structuredContent
		if (!mcpListPage || !Array.isArray(mcpListPage.items) || mcpListPage.items.length !== 1 || mcpListPage.items[0]?.key !== viewId)
			throw new Error('Live MCP discovery did not expose the selected Workspace View.')
	}
	finally {
		if (client) await client.close().catch(() => undefined)
		await stopServer(server)
	}

	console.log(`Package smoke passed: packed @deviltea/uiux@${installedPackage.version} starts via uiux dev and shares one selected Workspace across HTTP and MCP.`)
}
finally {
	await rm(temporaryDirectory, { recursive: true, force: true })
}
