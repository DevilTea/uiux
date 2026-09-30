#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

function showHelp() {
	console.log(`Usage: uiux <command>

Options:
  -h, --help     Show help
  -v, --version  Show version

Commands:
  init           Initialize a Workspace (not implemented yet)
  dev            Start the UIUX workbench (not implemented yet)`)
}

const [command, ...extraArgs] = process.argv.slice(2)

if (extraArgs.length === 0 && (command === undefined || command === '--help' || command === '-h')) {
	showHelp()
} else if (extraArgs.length === 0 && (command === '--version' || command === '-v')) {
	console.log(`uiux ${packageJson.version}`)
} else if (command === 'init' || command === 'dev') {
	console.error(`uiux: ${command} is not implemented yet.`)
	process.exitCode = 2
} else {
	console.error(`uiux: unknown command or option: ${[command, ...extraArgs].filter(Boolean).join(' ')}`)
	showHelp()
	process.exitCode = 2
}
