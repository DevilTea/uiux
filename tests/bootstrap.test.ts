import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import nuxtConfig from '../nuxt.config'
import { healthResponse } from '../src/server/health'

const rootDirectory = fileURLToPath(new URL('..', import.meta.url))
const cliPath = `${rootDirectory}/bin/uiux.mjs`

describe('bootstrap', () => {
	it('declares the canonical public package and CLI binary', () => {
		const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

		expect(packageJson.name).toBe('@deviltea/uiux')
		expect(packageJson.private).toBeUndefined()
		expect(packageJson.bin).toEqual({ uiux: './bin/uiux.mjs' })
	})

	it('prints useful CLI help and marks product commands as unavailable', () => {
		const output = execFileSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' })

		expect(output).toContain('Usage: uiux <command>')
		expect(output).toContain('init           Initialize a Workspace (not implemented yet)')
		expect(output).toContain('dev            Start the UIUX workbench (not implemented yet)')
	})

	it('fails clearly when a placeholder product command is invoked', () => {
		const result = spawnSync(process.execPath, [cliPath, 'init'], { encoding: 'utf8' })

		expect(result.status).toBe(2)
		expect(result.stdout).toBe('')
		expect(result.stderr).toContain('uiux: init is not implemented yet.')
	})

	it('prints the package version through the CLI', () => {
		const output = execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' })

		expect(output.trim()).toBe('uiux 0.1.0')
	})

	it('returns a stable, domain-free Nitro health response', () => {
		expect(healthResponse).toEqual({ status: 'ok' })
	})

	it('builds a client-rendered Nuxt app while retaining the Nitro node server', () => {
		expect(nuxtConfig.ssr).toBe(false)
		expect(nuxtConfig.nitro?.preset).toBe('node-server')
	})
})
