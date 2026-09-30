#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const host = '127.0.0.1'
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'uiux-package-smoke-'))
const packDirectory = join(temporaryDirectory, 'pack')
const installDirectory = join(temporaryDirectory, 'install')

async function selectPort() {
	const probe = createServer()
	await new Promise((resolve, reject) => {
		probe.once('error', reject)
		probe.listen(0, host, resolve)
	})
	const address = probe.address()
	if (!address || typeof address === 'string') {
		throw new Error('Could not select a local port for the package smoke check.')
	}
	const port = address.port
	await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
	return port
}

async function waitForHealth(port, server, output) {
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(`Packed Nitro server exited before becoming ready.\n${output()}`)
		}
		try {
			return await fetch(`http://${host}:${port}/api/health`)
		}
		catch {
			await new Promise(resolve => setTimeout(resolve, 150))
		}
	}
	throw new Error(`Packed Nitro server did not become ready within 15 seconds.\n${output()}`)
}

try {
	execFileSync('mkdir', ['-p', packDirectory, installDirectory])

	const packedFilename = execFileSync('npm', [
		'pack',
		'--pack-destination',
		packDirectory,
		'--silent',
	], { encoding: 'utf8' }).trim().split('\n').at(-1)

	if (!packedFilename) {
		throw new Error('npm pack did not report a tarball filename.')
	}

	const tarballPath = join(packDirectory, packedFilename)
	await writeFile(join(installDirectory, 'package.json'), JSON.stringify({ private: true }, null, 2))
	execFileSync('npm', [
		'install',
		'--ignore-scripts',
		'--no-audit',
		'--no-fund',
		tarballPath,
	], {
		cwd: installDirectory,
		stdio: 'pipe',
	})

	const packageRoot = join(installDirectory, 'node_modules', '@deviltea', 'uiux')
	const installedPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
	const cliPath = join(installDirectory, 'node_modules', '.bin', 'uiux')

	const helpOutput = execFileSync(cliPath, ['--help'], { encoding: 'utf8' })
	if (!helpOutput.includes('Usage: uiux <command>')) {
		throw new Error('Packed CLI help did not expose the expected usage line.')
	}

	const versionOutput = execFileSync(cliPath, ['--version'], { encoding: 'utf8' }).trim()
	if (versionOutput !== `uiux ${installedPackage.version}`) {
		throw new Error(`Packed CLI version mismatch: ${versionOutput}`)
	}

	const port = await selectPort()
	const server = spawn(process.execPath, [join(packageRoot, '.output', 'server', 'index.mjs')], {
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

	try {
		const response = await waitForHealth(port, server, () => serverOutput)
		if (response.status !== 200) {
			throw new Error(`Packed GET /api/health returned HTTP ${response.status}.`)
		}
		const body = await response.json()
		if (JSON.stringify(body) !== JSON.stringify({ status: 'ok' })) {
			throw new Error(`Packed GET /api/health returned an unexpected body: ${JSON.stringify(body)}`)
		}
	}
	finally {
		server.kill('SIGTERM')
	}

	console.log(`Package smoke passed: packed @deviltea/uiux@${installedPackage.version} installs, CLI runs, and Nitro serves /api/health.`)
}
finally {
	await rm(temporaryDirectory, { recursive: true, force: true })
}
