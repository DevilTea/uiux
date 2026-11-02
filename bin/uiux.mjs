#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
  init [--workspace <dir>]
                           Initialize a Workspace in <dir>, by default in .uiux/ of the
                           Git repository's top level (of the current directory outside
                           a repository): workspace.json, product-kit.json,
                           access-presets.json (the built-in Access presets), an empty
                           default-Locale file i18n/en-US.json and a .gitignore for
                           the runtime files, kit/node_modules/ and kit/dist/
  dev [--workspace <dir>] [--host <address>] [--origin <url>]...
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
  components list [--workspace <dir>]
                           List the components of the Workspace's Product Kit registry
  components add <name...> --to <dir> [--project <dir>] [--force] [--workspace <dir>]
                           Copy the named components and the components they require
                           from the Workspace's kit/src/ into <dir> of a product project,
                           keeping their paths below kit/src/, record them in the
                           project's uiux-components.json, and print the packages, with
                           their version ranges, they need. The product project is
                           --project, else the nearest directory at or above <dir> with
                           a package.json, else the Git top level; <dir> lies strictly
                           inside it. A changed copy, an unrecorded file in the way, or
                           a component already copied to another directory refuses the
                           copy; --force overwrites and moves, but still refuses a move
                           that would break a recorded component requiring a moved one
                           (name that component too to move it). Needs no credential
  components diff [--project <dir>] [--workspace <dir>] [--check]
                           Report the drift state of every file in the product
                           project's uiux-components.json (the project defaults to the
                           current directory's); --check exits 1 when any file is not
                           unchanged
  evidence capture (--all | --view <id>...) [--variant <name>...] [--locale <tag>...]
                           [--viewport <id>...] [--theme <id>...] [--workspace <dir>]
                           [--origin <url>] [--token-file <path|->] [--json]
                           Capture formal Evidence through a running uiux dev server,
                           as the member whose Token it reads from --token-file (- is
                           standard input) or the UIUX_TOKEN environment variable
                           (never from an option; the member needs evidence.capture).
                           --all captures every View in every Locale, viewport preset
                           and theme at its base context; --view captures the named
                           Views, in the Workspace default Locale, viewport and theme
                           unless --locale, --viewport or --theme (each repeatable)
                           name others, and --variant adds the named Variants. The
                           server is --origin, else the loopback origin of the uiux dev
                           server running on this host for the Workspace. Prints one
                           tab-separated line per context (captured|failed, View id,
                           Variant or -, Locale, viewport, theme, evidence digest) and a
                           count; --json prints the result as one JSON object. Exits 1
                           when any context fails or the server refuses or is not found
  artifacts gc [--workspace <dir>] [--dry-run]
                           Delete the blobs of the Workspace's derived-artifact store
                           (artifacts/) that nothing still needs: what a Review
                           submission, a Checkpoint or this host's history of the
                           Workspace references and the latest Evidence of each View
                           and render context are kept, with what they reference;
                           Handoff blobs are not. Prints each
                           deleted blob's sha256: identity, then their count and total
                           bytes; --dry-run prints the same and deletes nothing. Refused
                           while a uiux dev server serves the Workspace. No other
                           command deletes artifacts

Workspace selection: --workspace <dir> names the Workspace root, or a directory whose
.uiux/ holds one. Without it, a command uses the .uiux/ of the nearest directory, from
the current one upward to your home directory (outside it, only the current directory),
that has a .uiux/workspace.json. A Workspace at another schemaVersion than this UIUX
reads is refused. A .uiux/ that another user owns or others can
write, or in a directory others can write, is refused.

Access (each takes [--workspace <dir>]; rosters live in $UIUX_HOME, default ~/.uiux):
  member add <nick> (--preset <name> | --keys <k,...> | --all-keys) [--kind human|agent]
  member set <nick> [--preset <name>] [--grant <k,...>] [--revoke <k,...>] [--nickname <new>]
  member list [--keys] | member remove <nick>
                           --preset copies an Access preset's keys (Viewer, Reviewer,
                           Editor or Owner); an Agent never gets humanOnly keys such
                           as members.manage. Keys are comma-separated, such as
                           views.write,flows.write
  token create --member <nick> [--label <text>] [--expires <days>|never]
  token list [--member <nick>] [--all] | token revoke <token-id>
  invite create --member <nick> [--origin <url>] [--expires <hours>]
  session list | session revoke <session-id> | session revoke --member <nick>
  access copy --from <old-dir> [--replace]
                           Copy members, tokens and host history from another
                           Workspace path, once, such as after moving a Workspace or
                           for a worktree; run it before the first uiux dev there.
                           --replace discards the target's roster and its own host
                           history`)
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

/** `[--workspace <dir>]`: `{ workspace }` (undefined when omitted), or undefined for invalid usage. */
function parseOptionalWorkspaceArgument(args) {
	if (args.length === 0) return { workspace: undefined }
	return args.length === 2 && args[0] === '--workspace' && args[1] && !args[1].startsWith('--') ? { workspace: args[1] } : undefined
}

/** `dev [--workspace <dir>] [--host <address>] [--origin <url>]...`; undefined for invalid usage. */
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
	return { workspace, host, origins }
}

/**
 * Initialization, components, Evidence capture, artifact cleanup and access administration reuse the TypeScript modules shipped in `src/`. They are
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

async function runAccess(argv) {
	await runBundled('src/cli/access.ts', ({ runAccessCommand }) => runAccessCommand({ argv }))
}

async function runInit(workspace) {
	await runBundled('src/cli/init.ts', ({ runInitCommand }) => runInitCommand(workspace === undefined ? {} : { workspace }))
}

async function runDev(options) {
	// `--workspace <dir>` or discovery, then the layout entry check, before the server starts (and so
	// before any lock or server hold).
	const selection = await withBundled('src/cli/workspace-selection.ts', module => module.selectCliWorkspace(options.workspace, process.cwd()))
	if (!selection.ok) {
		console.error(`uiux: ${selection.message}`)
		process.exitCode = 2
		return
	}
	const workspaceRoot = selection.root

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
	const options = parseOptionalWorkspaceArgument(extraArgs)
	if (!options) {
		console.error('uiux: init accepts only --workspace <dir>.')
		process.exitCode = 2
	} else {
		await runInit(options.workspace)
	}
} else if (command === 'dev') {
	const options = parseDevArguments(extraArgs)
	if (!options) {
		console.error('uiux: dev accepts --workspace <dir>, --host <address> and repeated --origin <url>.')
		process.exitCode = 2
	} else {
		await runDev(options)
	}
} else if (command === 'components') {
	try {
		await runBundled('src/cli/components.ts', ({ runComponentsCommand }) => runComponentsCommand({ argv: extraArgs, cwd: process.cwd() }))
	}
	catch (error) {
		console.error('uiux: components failed: ' + (error instanceof Error ? error.message : String(error)))
		process.exitCode = 1
	}
} else if (command === 'evidence') {
	try {
		await runBundled('src/cli/evidence.ts', ({ runEvidenceCommand }) => runEvidenceCommand({ argv: extraArgs, cwd: process.cwd() }))
	}
	catch (error) {
		console.error('uiux: evidence failed: ' + (error instanceof Error ? error.message : String(error)))
		process.exitCode = 1
	}
} else if (command === 'artifacts') {
	try {
		await runBundled('src/cli/artifacts.ts', ({ runArtifactsCommand }) => runArtifactsCommand({ argv: extraArgs, cwd: process.cwd() }))
	}
	catch (error) {
		console.error('uiux: artifacts failed: ' + (error instanceof Error ? error.message : String(error)))
		process.exitCode = 1
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
