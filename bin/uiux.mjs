#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

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
  dev --workspace <dir> [--host <address>] [--origin <url>]...
                           Start the unified UIUX Workbench/Nitro server. By default
                           it listens on loopback only (127.0.0.1; PORT selects the
                           port, default 3000) and accepts only loopback host names.
                           --host takes a loopback address (127.0.0.1, ::1, localhost)
                           or a wildcard address (0.0.0.0, ::), which needs an origin.
                           Each --origin (repeatable) is an http:// or https:// origin
                           people use to reach the server, such as a reverse proxy's
                           https://uiux.corp.example or http://10.0.0.5:3000 on a LAN;
                           an http origin sends credentials in clear text. UIUX serves
                           plain HTTP; a TLS-terminating proxy serves https origins.
                           Every /api and /mcp request needs a credential; the first
                           start of a Workspace creates its Owner and prints a
                           one-time sign-in link on each URL
  migrate --workspace <dir> [--dry-run]
                           Migrate an older Workspace schema to schemaVersion ${workspaceSchemaVersion}
                           (steps chain: uiux.v1-to-v2, uiux.v2-to-v3, uiux.v3-to-v4);
                           a real run first writes the Checkpoint "Before migration to
                           schemaVersion ${workspaceSchemaVersion}" and then records the migration in the host
                           history ($UIUX_HOME); --dry-run prints the steps and changed
                           files without writing anything

Access (each takes --workspace <dir>; rosters live in $UIUX_HOME, default ~/.uiux):
  member add <nick> --role <owner|editor|reviewer|viewer> [--kind human|agent]
  member list | member set <nick> [--role <role>] [--nickname <new>] | member remove <nick>
  token create --member <nick> [--label <text>] [--expires <days>|never]
  token list [--member <nick>] [--all] | token revoke <token-id>
  invite create --member <nick> [--origin <url>] [--expires <hours>]
  session list | session revoke <session-id> | session revoke --member <nick>
  access copy --from <old-dir> [--replace]
                           Copy members, tokens and host history from another
                           Workspace path, once. Copy before running uiux migrate on
                           the new path: --replace discards the target's roster and
                           its own host history, migration system versions included`)
}

// `uiux dev` takes its bind address only from --host. For compatibility, a loopback HOST or
// NITRO_HOST still selects the loopback address when --host is absent; any other value is refused.
// The server it spawns gets the bind address and the origins through an internal handoff, never
// through HOST/NITRO_HOST, so a packaged server run directly stays loopback-only
// (server/plugins/loopback-guard.ts).
const LOOPBACK_ENV_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function loopbackHostFromEnv(env) {
	let selected
	for (const variable of ['NITRO_HOST', 'HOST']) {
		const raw = env[variable]
		if (raw === undefined || raw.trim() === '') continue
		if (!LOOPBACK_ENV_HOSTS.has(raw.trim().toLowerCase())) {
			return {
				ok: false,
				message: `Refusing to listen on ${variable}=${raw}. uiux dev takes its bind address from --host only: a loopback address, or a wildcard address (0.0.0.0, ::) together with --origin <url>.`,
			}
		}
		selected ??= raw.trim()
	}
	return { ok: true, host: selected }
}

function parseWorkspaceArgument(args) {
	return args.length === 2 && args[0] === '--workspace' && args[1] ? args[1] : undefined
}

/** `dev --workspace <dir> [--host <address>] [--origin <url>]...`; undefined for invalid usage. */
function parseDevArguments(args) {
	let workspace
	let host
	const origins = []
	for (let index = 0; index < args.length; index += 2) {
		const name = args[index]
		const value = args[index + 1]
		if (value === undefined || value === '' || value.startsWith('--')) return undefined
		if (name === '--workspace' && workspace === undefined) workspace = value
		else if (name === '--host' && host === undefined) host = value
		else if (name === '--origin') origins.push(value)
		else return undefined
	}
	return workspace === undefined ? undefined : { workspace, host, origins }
}

function parseMigrateArguments(args) {
	const dryRun = args.includes('--dry-run')
	const rest = args.filter(arg => arg !== '--dry-run')
	if (args.length - rest.length > 1) return undefined
	const workspace = parseWorkspaceArgument(rest)
	return workspace ? { workspace, dryRun } : undefined
}

/**
 * Migration and access administration reuse the TypeScript modules shipped in `src/`. They are
 * bundled on demand with the packaged esbuild dependency into a private temporary module, so the
 * CLI applies exactly the policy the server enforces.
 */
async function runBundled(entry, run) {
	process.exitCode = await withBundled(entry, run)
}

async function withBundled(entry, use) {
	const { default: esbuild } = await import('esbuild')
	const packageRoot = fileURLToPath(new URL('..', import.meta.url))
	const build = await esbuild.build({
		entryPoints: [resolve(packageRoot, entry)],
		bundle: true,
		platform: 'node',
		format: 'esm',
		target: 'node24',
		write: false,
		logLevel: 'silent',
	})
	const directory = await mkdtemp(join(tmpdir(), 'uiux-cli-'))
	try {
		const modulePath = join(directory, 'command.mjs')
		await writeFile(modulePath, build.outputFiles[0].contents)
		return await use(await import(pathToFileURL(modulePath).href))
	}
	finally {
		await rm(directory, { recursive: true, force: true })
	}
}

async function runMigrate(options) {
	await runBundled('src/cli/migrate.ts', ({ runMigrateCommand }) => runMigrateCommand({
		workspaceRoot: resolve(process.cwd(), options.workspace),
		dryRun: options.dryRun,
	}))
}

async function runAccess(argv) {
	await runBundled('src/cli/access.ts', ({ runAccessCommand }) => runAccessCommand({ argv }))
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

async function runDev(options) {
	const workspaceRoot = resolve(process.cwd(), options.workspace)
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

	// UIUX serves plain HTTP only; an https origin is served by a TLS-terminating front end.
	if (process.env.NITRO_SSL_CERT || process.env.NITRO_SSL_KEY) {
		console.error('uiux: NITRO_SSL_CERT and NITRO_SSL_KEY are not supported: UIUX serves plain HTTP only. Serve an https origin through a TLS-terminating front end and list it with --origin https://<host>.')
		process.exitCode = 2
		return
	}
	let host = options.host
	if (host === undefined) {
		const fromEnv = loopbackHostFromEnv(process.env)
		if (!fromEnv.ok) {
			console.error(`uiux: ${fromEnv.message}`)
			process.exitCode = 2
			return
		}
		host = fromEnv.host
	}
	const network = await withBundled('src/server/network-access.ts', (module) => {
		const port = module.resolveListenPort(process.env)
		const resolved = module.resolveNetworkConfig({ ...(host === undefined ? {} : { host }), origins: options.origins, port })
		return { resolved, handoff: module.encodeDevHandoff({ host, origins: options.origins }), variable: module.DEV_HANDOFF_VARIABLE }
	})
	if (!network.resolved.ok) {
		console.error(`uiux: ${network.resolved.message}`)
		process.exitCode = 2
		return
	}

	const packageRoot = fileURLToPath(new URL('..', import.meta.url))
	const serverEntry = resolve(packageRoot, '.output/server/index.mjs')
	const env = {
		...process.env,
		UIUX_WORKSPACE_ROOT: workspaceRoot,
		UIUX_PACKAGE_ROOT: packageRoot,
		[network.variable]: network.handoff,
	}
	// The server takes its bind address from the handoff only.
	delete env.HOST
	delete env.NITRO_HOST
	delete env.NITRO_UNIX_SOCKET
	const { bindHost, origins } = network.resolved.value
	const reach = origins.length === 0 ? 'loopback only' : `loopback and ${origins.length} configured origin${origins.length === 1 ? '' : 's'}`
	console.log(`uiux: serving Workspace ${workspaceRoot} on ${bindHost} (${reach}).`)
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
	const options = parseDevArguments(extraArgs)
	if (!options) {
		console.error('uiux: dev requires --workspace <dir> and accepts --host <address> and repeated --origin <url>.')
		process.exitCode = 2
	} else {
		await runDev(options)
	}
} else if (command === 'migrate') {
	const options = parseMigrateArguments(extraArgs)
	if (!options) {
		console.error('uiux: migrate requires --workspace <dir> and accepts --dry-run.')
		process.exitCode = 2
	} else {
		try {
			await runMigrate(options)
		}
		catch (error) {
			console.error('uiux: migrate failed: ' + (error instanceof Error ? error.message : String(error)))
			process.exitCode = 1
		}
	}
} else if (['member', 'token', 'invite', 'session', 'access'].includes(command)) {
	try {
		await runAccess([command, ...extraArgs])
	}
	catch (error) {
		console.error(`uiux: ${command} failed: ` + (error instanceof Error ? error.message : String(error)))
		process.exitCode = 1
	}
} else {
	console.error(`uiux: unknown command or option: ${[command, ...extraArgs].filter(Boolean).join(' ')}`)
	showHelp()
	process.exitCode = 2
}
