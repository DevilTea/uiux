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
	const viewId = '11111111-1111-4111-8111-111111111111'

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
	if (!helpOutput.includes('init --workspace <dir>'))
		throw new Error('Packed CLI help did not expose Workspace initialization.')
	const initOutput = execFileSync(cliPath, ['init', '--workspace', workspaceDirectory], { encoding: 'utf8' })
	if (!initOutput.includes('Initialized UIUX Workspace'))
		throw new Error(`Packed CLI init returned an unexpected response: ${initOutput}`)
	const initializedManifest = JSON.parse(await readFile(join(workspaceDirectory, '.uiux', 'workspace.json'), 'utf8'))
	if (initializedManifest.schemaVersion !== installedPackage.uiuxWorkspaceSchemaVersion)
		throw new Error('Packed CLI init did not use the package Workspace schema authority.')

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

		const workbenchResponse = await fetch(`http://${host}:${port}/`)
		if (workbenchResponse.status !== 200)
			throw new Error(`Packed Workbench returned HTTP ${workbenchResponse.status}.`)
		const workbenchHtml = await workbenchResponse.text()
		const stylesheetHrefs = [...workbenchHtml.matchAll(/href="([^"]+\.css)"/g)].map(match => match[1])
		if (!stylesheetHrefs.length)
			throw new Error('Packed Workbench HTML did not reference any stylesheet.')
		const stylesheetBodies = await Promise.all(stylesheetHrefs.map(async (href) => {
			const response = await fetch(new URL(href, `http://${host}:${port}/`))
			if (!response.ok) throw new Error(`Packed Workbench stylesheet ${href} returned HTTP ${response.status}.`)
			return await response.text()
		}))
		const combinedStyles = stylesheetBodies.join('\n')
		if (!combinedStyles.includes('--ui-bg:') || !combinedStyles.includes('.min-h-screen'))
			throw new Error('Packed Workbench stylesheets are missing Nuxt UI theme tokens or Tailwind utilities.')

		const workspaceResponse = await fetch(`http://${host}:${port}/api/resources/workspace/workspace`)
		if (workspaceResponse.status !== 200)
			throw new Error(`Packed selected-Workspace API returned HTTP ${workspaceResponse.status}.`)
		const workspaceRead = await workspaceResponse.json()
		if (workspaceRead.kind !== 'workspace' || workspaceRead.resource?.schemaVersion !== installedPackage.uiuxWorkspaceSchemaVersion || workspaceRead.inspection?.state !== 'current')
			throw new Error(`Packed selected-Workspace API returned an unexpected body: ${JSON.stringify(workspaceRead)}`)

		client = new Client({ name: 'uiux-package-smoke', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`))
		await client.connect(transport)
		const created = await client.callTool({
			name: 'create_view',
			arguments: {
				id: viewId,
				name: 'Package smoke view',
				feature: 'dogfood',
				spec: {
					intent: 'Exercise the installed UIUX authoring path.',
					entryConditions: [],
					interactionRules: [],
					constraints: [],
					accessibility: [],
					references: [],
				},
			},
		})
		if (created.isError || created.structuredContent?.status !== 'created')
			throw new Error(`Packed MCP create_view failed: ${JSON.stringify(created.structuredContent)}`)
		const createdRevision = created.structuredContent.revision
		const authoredIr = {
			id: 'root',
			slots: {
				content: [
					{
						id: 'box-1',
						props: { title: 'Smoke content' },
						type: 'WorkbenchBox',
					},
				],
			},
			type: 'RootShell',
		}
		const authoredVariants = {
			compact: {
				state: {
					'box-1': {
						collapsed: true,
					},
				},
			},
		}
		const structured = await client.callTool({
			name: 'update_view_structure',
			arguments: {
				viewId,
				expectedRevision: createdRevision,
				ir: authoredIr,
				variants: authoredVariants,
			},
		})
		if (structured.isError || structured.structuredContent?.status !== 'updated')
			throw new Error(`Packed MCP update_view_structure failed: ${JSON.stringify(structured.structuredContent)}`)
		const structureRevision = structured.structuredContent.revision

		const updated = await client.callTool({
			name: 'update_view_spec',
			arguments: {
				viewId,
				expectedRevision: structureRevision,
				spec: {
					intent: 'Exercise installed UIUX init, MCP authoring, and Workbench reads.',
					entryConditions: ['The packed server is running.'],
					interactionRules: [],
					constraints: ['Writes use observed revisions.'],
					accessibility: [],
					references: [],
				},
			},
		})
		if (updated.isError || updated.structuredContent?.status !== 'updated')
			throw new Error(`Packed MCP update_view_spec failed: ${JSON.stringify(updated.structuredContent)}`)

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

		const viewResponse = await fetch(`http://${host}:${port}/api/resources/view/${viewId}`)
		if (viewResponse.status !== 200) throw new Error(`Packed authored View read returned HTTP ${viewResponse.status}.`)
		const viewRead = await viewResponse.json()
		if (viewRead.resource?.spec?.intent !== 'Exercise installed UIUX init, MCP authoring, and Workbench reads.')
			throw new Error(`Packed authored View did not preserve the MCP update: ${JSON.stringify(viewRead)}`)
		if (JSON.stringify(viewRead.resource?.ir) !== JSON.stringify(authoredIr))
			throw new Error(`Packed authored View HTTP read did not match authored IR: ${JSON.stringify(viewRead.resource?.ir)}`)
		if (JSON.stringify(viewRead.resource?.variants) !== JSON.stringify(authoredVariants))
			throw new Error(`Packed authored View HTTP read did not match authored variants: ${JSON.stringify(viewRead.resource?.variants)}`)

		const mcpViewRead = await client.readResource({ uri: `uiux://view/${viewId}` })
		const mcpViewContent = mcpViewRead.contents[0]
		const mcpView = mcpViewContent && 'text' in mcpViewContent ? JSON.parse(mcpViewContent.text) : undefined
		if (JSON.stringify(mcpView?.resource?.ir) !== JSON.stringify(authoredIr))
			throw new Error(`Packed authored View MCP read did not match authored IR: ${JSON.stringify(mcpView?.resource?.ir)}`)
		if (JSON.stringify(mcpView?.resource?.variants) !== JSON.stringify(authoredVariants))
			throw new Error(`Packed authored View MCP read did not match authored variants: ${JSON.stringify(mcpView?.resource?.variants)}`)

		const mcpRead = await client.readResource({ uri: 'uiux://workspace' })
		const content = mcpRead.contents[0]
		const mcpWorkspace = content && 'text' in content ? JSON.parse(content.text) : undefined
		if (mcpWorkspace?.revision !== workspaceRead.revision || mcpWorkspace?.resource?.schemaVersion !== installedPackage.uiuxWorkspaceSchemaVersion)
			throw new Error('Live MCP did not read the same selected Workspace revision as HTTP.')
		const mcpList = await client.callTool({ name: 'list_resources', arguments: { kinds: ['view'], limit: 10 } })
		const mcpListPage = mcpList.structuredContent
		if (!mcpListPage || !Array.isArray(mcpListPage.items) || mcpListPage.items.length !== 1 || mcpListPage.items[0]?.key !== viewId)
			throw new Error('Live MCP discovery did not expose the selected Workspace View.')

		// Configure workspace viewports and themes via MCP
		const wsUpdate = await client.callTool({
			name: 'update_workspace_settings',
			arguments: {
				expectedRevision: workspaceRead.revision,
				settings: {
					i18n: { defaultLocale: 'en-US' },
					adapters: [],
					viewports: {
						desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } },
					},
					themes: {
						light: { label: 'Light' },
					},
				},
			},
		})
		if (wsUpdate.isError || wsUpdate.structuredContent?.status !== 'updated')
			throw new Error(`Packed MCP update_workspace_settings failed: ${JSON.stringify(wsUpdate.structuredContent)}`)

		// Create canonical default locale via MCP
		const locCreate = await client.callTool({
			name: 'create_locale',
			arguments: {
				locale: 'en-US',
				messages: { 'smoke.hello': 'Hello' },
			},
		})
		if (locCreate.isError || locCreate.structuredContent?.status !== 'created')
			throw new Error(`Packed MCP create_locale failed: ${JSON.stringify(locCreate.structuredContent)}`)

		// Create a view with RootShell for formal capture & handoff
		const captureViewId = '22222222-2222-4222-8222-222222222222'
		const captureViewCreate = await client.callTool({
			name: 'create_view',
			arguments: {
				id: captureViewId,
				name: 'Package smoke capture view',
				feature: 'dogfood',
				spec: {
					intent: 'Test formal capture and handoff in package smoke.',
					entryConditions: [],
					interactionRules: [],
					constraints: [],
					accessibility: [],
					references: [],
				},
			},
		})
		if (captureViewCreate.isError || captureViewCreate.structuredContent?.status !== 'created')
			throw new Error(`Packed MCP create_view for capture failed: ${JSON.stringify(captureViewCreate.structuredContent)}`)

		// Exercise capture & handoff semantics on the installed package
		const captureCall = await client.callTool({
			name: 'capture_formal_evidence',
			arguments: {
				contexts: [{
					viewId: captureViewId,
					locale: 'en-US',
					viewportId: 'desktop',
					viewport: { width: 1280, height: 800 },
					themeId: 'light',
				}],
			},
		})

		const captureData = captureCall.structuredContent
		let capturedEvidence = false
		if (captureData?.status === 'ok' && captureData?.results?.[0]?.status === 'captured') {
			capturedEvidence = true
		} else if (captureData?.results?.[0]?.diagnostics?.some(d => d.code === 'capture.browser_launch_failed')) {
			// Gracefully handled missing browser executable
		} else {
			throw new Error(`Packed MCP capture_formal_evidence returned unexpected output: ${JSON.stringify(captureData)}`)
		}

		const assessCall = await client.callTool({
			name: 'assess_handoff_readiness',
			arguments: {
				roots: [{ type: 'view', viewId: captureViewId }],
			},
		})
		const assessData = assessCall.structuredContent
		if (assessData?.status !== 'ok')
			throw new Error(`Packed MCP assess_handoff_readiness failed: ${JSON.stringify(assessData)}`)

		if (capturedEvidence) {
			if (assessData.readiness?.implementationReady !== true)
				throw new Error(`Packed MCP assess_handoff_readiness expected ready when evidence captured: ${JSON.stringify(assessData)}`)
		} else {
			if (assessData.readiness?.implementationReady === true)
				throw new Error('Packed MCP assess_handoff_readiness claimed ready without evidence.')
		}

		const exportCall = await client.callTool({
			name: 'export_handoff',
			arguments: {
				roots: [{ type: 'view', viewId: captureViewId }],
			},
		})
		const exportData = exportCall.structuredContent
		if (exportData?.status !== 'exported' || !exportData.manifestArtifactDigest || !exportData.bundleIdentity)
			throw new Error(`Packed MCP export_handoff failed: ${JSON.stringify(exportData)}`)

		const manifestRes = await fetch(`http://${host}:${port}/api/artifacts/${exportData.manifestArtifactDigest}`)
		if (!manifestRes.ok)
			throw new Error(`Failed to download exported handoff manifest artifact: HTTP ${manifestRes.status}`)
		const manifestJson = await manifestRes.json()
		if (manifestJson.bundleIdentity !== exportData.bundleIdentity)
			throw new Error('Exported manifest bundleIdentity does not match export tool response.')
	}
	finally {
		if (client) await client.close().catch(() => undefined)
		await stopServer(server)
	}

	console.log(`Package smoke passed: packed @deviltea/uiux@${installedPackage.version} serves styled Workbench assets, initializes a Workspace, authors a View and structure through MCP, captures/evaluates formal evidence and exports handoff bundles, and shares it across HTTP/MCP.`)
}
finally {
	await rm(temporaryDirectory, { recursive: true, force: true })
}
