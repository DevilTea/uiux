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

	it('prints useful CLI help and exposes the canonical selected-Workspace dev command', () => {
		const output = execFileSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' })

		expect(output).toContain('Usage: uiux <command>')
		expect(output).toContain('init --workspace <dir>  Initialize a Workspace (not implemented yet)')
		expect(output).toContain('dev --workspace <dir>   Start the unified UIUX Workbench/Nitro server')
	})

	it('keeps init unavailable while rejecting malformed dev Workspace selection before server launch', () => {
		const init = spawnSync(process.execPath, [cliPath, 'init', '--workspace', '.'], { encoding: 'utf8' })
		expect(init.status).toBe(2)
		expect(init.stdout).toBe('')
		expect(init.stderr).toContain('uiux: init is not implemented yet.')

		for (const args of [['dev'], ['dev', '--workspace'], ['dev', '--workspace', '.', 'extra'], ['dev', '--other', '.']]) {
			const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
			expect(result.status).toBe(2)
			expect(result.stderr).toContain('uiux: dev requires exactly --workspace <dir>.')
		}
	})

	it('rejects a dev Workspace root that does not exist instead of silently creating it', () => {
		const result = spawnSync(process.execPath, [cliPath, 'dev', '--workspace', './definitely-missing-uiux-workspace'], { encoding: 'utf8' })
		expect(result.status).toBe(2)
		expect(result.stderr).toContain('Workspace root does not exist')
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
