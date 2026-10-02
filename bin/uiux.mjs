#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

function showHelp() {
	console.log(`Usage: uiux <command>

Options:
  -h, --help     Show help
  -v, --version  Show version

Commands:
  init --workspace <dir>  Initialize a Workspace (not implemented yet)
  dev --workspace <dir>   Start the unified UIUX Workbench/Nitro server`)
}

function parseWorkspaceArgument(args) {
	return args.length === 2 && args[0] === '--workspace' && args[1] ? args[1] : undefined
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

	const packageRoot = fileURLToPath(new URL('..', import.meta.url))
	const serverEntry = resolve(packageRoot, '.output/server/index.mjs')
	const child = spawn(process.execPath, [serverEntry], {
		stdio: 'inherit',
		env: { ...process.env, UIUX_WORKSPACE_ROOT: workspaceRoot },
	})
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
	console.error('uiux: init is not implemented yet.')
	process.exitCode = 2
} else if (command === 'dev') {
	const workspace = parseWorkspaceArgument(extraArgs)
	if (!workspace) {
		console.error('uiux: dev requires exactly --workspace <dir>.')
		process.exitCode = 2
	} else {
		await runDev(workspace)
	}
} else {
	console.error(`uiux: unknown command or option: ${[command, ...extraArgs].filter(Boolean).join(' ')}`)
	showHelp()
	process.exitCode = 2
}
