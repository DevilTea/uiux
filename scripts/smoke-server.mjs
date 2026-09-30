#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const host = '127.0.0.1'
const probe = createServer()
await new Promise((resolve, reject) => {
	probe.once('error', reject)
	probe.listen(0, host, resolve)
})
const address = probe.address()
if (!address || typeof address === 'string') {
	throw new Error('Could not select a local port for the Nitro smoke check.')
}
const port = address.port
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))

const server = spawn(process.execPath, ['.output/server/index.mjs'], {
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
server.stdout.setEncoding('utf8').on('data', (chunk) => serverOutput += chunk)
server.stderr.setEncoding('utf8').on('data', (chunk) => serverOutput += chunk)

try {
	const deadline = Date.now() + 15_000
	let response
	while (Date.now() < deadline) {
		if (server.exitCode !== null) {
			throw new Error(`Nitro server exited before becoming ready.\n${serverOutput}`)
		}
		try {
			response = await fetch(`http://${host}:${port}/api/health`)
			break
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 150))
		}
	}
	if (!response) {
		throw new Error(`Nitro server did not become ready within 15 seconds.\n${serverOutput}`)
	}
	if (response.status !== 200) {
		throw new Error(`GET /api/health returned HTTP ${response.status}.`)
	}
	const body = await response.json()
	if (JSON.stringify(body) !== JSON.stringify({ status: 'ok' })) {
		throw new Error(`GET /api/health returned an unexpected body: ${JSON.stringify(body)}`)
	}
	console.log('Nitro smoke passed: GET /api/health returned 200 {"status":"ok"}.')
} finally {
	server.kill('SIGTERM')
}
