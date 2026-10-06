#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { parsePublishArguments, runPublish } from './publish.mjs'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const workspaceSchemaVersion = packageJson.uiuxWorkspaceSchemaVersion

if (!Number.isInteger(workspaceSchemaVersion) || workspaceSchemaVersion < 1)
	throw new Error('package.json uiuxWorkspaceSchemaVersion must be a positive integer.')

function showHelp() {
	console.log(`Usage: uiux <command>

Options:
  -h, --help     Show help
  -v, --version  Show version

Commands:
  init --workspace <dir>  Initialize a Workspace
  dev --workspace <dir>   Start the unified UIUX Workbench/Nitro server on loopback
                           only (127.0.0.1; PORT selects the port, default 3000)
  publish --workspace <dir> --out <dir> [--base <path>] [--source-revision <rev>]
                           Publish a read-only static UIUX Workspace`)
}

// The first version is single-user and unauthenticated, so `uiux dev` is loopback-only and refuses
// a non-loopback value in either HOST or NITRO_HOST. The packaged server applies the same allowlist
// to its effective bind (src/server/loopback-guard.ts) as a backstop for direct `.output` runs.
const LOOPBACK_BIND_HOSTS = new Map([
	['127.0.0.1', '127.0.0.1'],
	['localhost', 'localhost'],
	['::1', '::1'],
	['[::1]', '::1'],
])

function resolveLoopbackBindHost(env) {
	let selected
	for (const variable of ['NITRO_HOST', 'HOST']) {
		const raw = env[variable]
		if (raw === undefined || raw.trim() === '') continue
		const normalized = LOOPBACK_BIND_HOSTS.get(raw.trim().toLowerCase())
		if (!normalized) {
			return {
				ok: false,
				message: `Refusing to listen on ${variable}=${raw}. UIUX serves the Workbench, /api and /mcp without authentication, so it listens on loopback only (127.0.0.1, ::1 or localhost). LAN exposure requires authentication, which is not yet available.`,
			}
		}
		selected ??= normalized
	}
	return { ok: true, host: selected ?? '127.0.0.1' }
}

function parseWorkspaceArgument(args) {
	return args.length === 2 && args[0] === '--workspace' && args[1] ? args[1] : undefined
}

async function runInit(workspaceArgument) {
	const workspaceRoot = resolve(process.cwd(), workspaceArgument)
	try {
		const rootStat = await stat(workspaceRoot)
		if (!rootStat.isDirectory()) {
			console.error(`uiux: Workspace root is not a directory: ${workspaceRoot}`)
			process.exitCode = 2
			return
		}
	}
	catch (error) {
		if (error?.code !== 'ENOENT') throw error
		await mkdir(workspaceRoot, { recursive: true })
	}

	const metadataRoot = join(workspaceRoot, '.uiux')
	await mkdir(metadataRoot, { recursive: true })
	const metadataStat = await lstat(metadataRoot)
	if (!metadataStat.isDirectory() || metadataStat.isSymbolicLink()) {
		console.error(`uiux: Workspace metadata path must be a real directory: ${metadataRoot}`)
		process.exitCode = 2
		return
	}

	const manifestPath = join(metadataRoot, 'workspace.json')
	const manifest = {
		schemaVersion: workspaceSchemaVersion,
		i18n: { defaultLocale: 'en-US' },
		adapters: [],
		viewports: {},
		themes: {},
	}
	try {
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
	}
	catch (error) {
		if (error?.code !== 'EEXIST') throw error
		console.error(`uiux: Workspace is already initialized: ${manifestPath}`)
		process.exitCode = 2
		return
	}
	console.log(`Initialized UIUX Workspace at ${workspaceRoot}`)
}

async function runDev(workspaceArgument) {
	const workspaceRoot = resolve(process.cwd(), workspaceArgument)
	let workspaceStat
	try {
		workspaceStat = await stat(workspaceRoot)
	}
	catch {
		console.error(`uiux: Workspace root does not exist: ${workspaceRoot}`)
		process.exitCode = 2
		return
	}
	if (!workspaceStat.isDirectory()) {
		console.error(`uiux: Workspace root is not a directory: ${workspaceRoot}`)
		process.exitCode = 2
		return
	}

	const bind = resolveLoopbackBindHost(process.env)
	if (!bind.ok) {
		console.error(`uiux: ${bind.message}`)
		process.exitCode = 2
		return
	}

	const packageRoot = fileURLToPath(new URL('..', import.meta.url))
	const serverEntry = resolve(packageRoot, '.output/server/index.mjs')
	const env = {
		...process.env,
		HOST: bind.host,
		NITRO_HOST: bind.host,
		UIUX_WORKSPACE_ROOT: workspaceRoot,
		UIUX_PACKAGE_ROOT: packageRoot,
	}
	delete env.NITRO_UNIX_SOCKET
	console.log(`uiux: serving Workspace ${workspaceRoot} on loopback only (${bind.host}).`)
	const child = spawn(process.execPath, [serverEntry], { stdio: 'inherit', env })
	const forwardSignal = signal => {
		if (child.exitCode === null && child.signalCode === null) child.kill(signal)
	}
	const forwardSigint = () => forwardSignal('SIGINT')
	const forwardSigterm = () => forwardSignal('SIGTERM')
	process.once('SIGINT', forwardSigint)
	process.once('SIGTERM', forwardSigterm)
	const result = await new Promise(resolveExit => {
		child.once('error', error => resolveExit({ error }))
		child.once('exit', (code, signal) => resolveExit({ code, signal }))
	})
	process.removeListener('SIGINT', forwardSigint)
	process.removeListener('SIGTERM', forwardSigterm)
	if (result.error) {
		console.error(`uiux: failed to start server: ${result.error.message}`)
		process.exitCode = 1
	} else if (result.signal) {
		process.exitCode = result.signal === 'SIGINT' || result.signal === 'SIGTERM' ? 0 : 1
	} else {
		process.exitCode = result.code ?? 1
	}
}

const [command, ...extraArgs] = process.argv.slice(2)

if (extraArgs.length === 0 && (command === undefined || command === '--help' || command === '-h')) {
	showHelp()
} else if (extraArgs.length === 0 && (command === '--version' || command === '-v')) {
	console.log(`uiux ${packageJson.version}`)
} else if (command === 'init') {
	const workspace = parseWorkspaceArgument(extraArgs)
	if (!workspace) {
		console.error('uiux: init requires exactly --workspace <dir>.')
		process.exitCode = 2
	} else {
		await runInit(workspace)
	}
} else if (command === 'dev') {
	const workspace = parseWorkspaceArgument(extraArgs)
	if (!workspace) {
		console.error('uiux: dev requires exactly --workspace <dir>.')
		process.exitCode = 2
	} else {
		await runDev(workspace)
	}
} else if (command === 'publish') {
	const options = parsePublishArguments(extraArgs)
	if (!options) {
		console.error('uiux: publish requires --workspace <dir> --out <dir> and accepts --base <path> and --source-revision <rev>.')
		process.exitCode = 2
	} else {
		try {
			const packageRoot = fileURLToPath(new URL('..', import.meta.url))
			await runPublish(options, packageRoot)
		}
		catch (error) {
			console.error('uiux: publish failed: ' + (error instanceof Error ? error.message : String(error)))
			process.exitCode = 1
		}
	}
} else {
	console.error(`uiux: unknown command or option: ${[command, ...extraArgs].filter(Boolean).join(' ')}`)
	showHelp()
	process.exitCode = 2
}
