import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import nuxtConfig from '../nuxt.config'
import { healthResponse } from '../src/server/health'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../src/product/workspace-schema'

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
		expect(output).toContain('init --workspace <dir>  Initialize a Workspace')
		expect(output).toContain('dev --workspace <dir> [--host <address>] [--origin <url>]...')
		expect(output).toContain('Start the unified UIUX Workbench/Nitro server')
		expect(output).not.toContain('publish')
	})

	it('treats publish as an unknown command now that static publication is removed', () => {
		for (const args of [['publish'], ['publish', '--workspace', '.', '--out', 'site']]) {
			const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
			expect(result.status).toBe(2)
			expect(result.stderr).toContain(`uiux: unknown command or option: ${args.join(' ')}`)
			// Usage follows, with no removal notice.
			expect(result.stdout).toContain('Usage: uiux <command>')
			expect(`${result.stdout}${result.stderr}`).not.toMatch(/removed|no longer/iu)
		}
	})

	it('initializes a minimal current-schema Workspace without overwriting an existing manifest', () => {
		const parent = mkdtempSync(join(tmpdir(), 'uiux-bootstrap-'))
		const workspace = join(parent, 'design')
		try {
			const output = execFileSync(process.execPath, [cliPath, 'init', '--workspace', workspace], { encoding: 'utf8' })
			expect(output).toContain('Initialized UIUX Workspace')
			const manifest = JSON.parse(readFileSync(join(workspace, '.uiux', 'workspace.json'), 'utf8'))
			expect(manifest).toEqual({
				schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
				i18n: { defaultLocale: 'en-US' },
				adapters: [],
				viewports: {},
				themes: {},
			})

			const repeated = spawnSync(process.execPath, [cliPath, 'init', '--workspace', workspace], { encoding: 'utf8' })
			expect(repeated.status).toBe(2)
			expect(repeated.stderr).toContain('Workspace is already initialized')
			expect(JSON.parse(readFileSync(join(workspace, '.uiux', 'workspace.json'), 'utf8'))).toEqual(manifest)
		}
		finally { rmSync(parent, { recursive: true, force: true }) }
	})

	it('rejects malformed init and dev Workspace selection before side effects', () => {
		for (const args of [['init'], ['init', '--workspace'], ['init', '--workspace', '.', 'extra'], ['init', '--other', '.']]) {
			const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
			expect(result.status).toBe(2)
			expect(result.stderr).toContain('uiux: init requires exactly --workspace <dir>.')
		}
		for (const args of [['dev'], ['dev', '--workspace'], ['dev', '--workspace', '.', 'extra'], ['dev', '--other', '.'], ['dev', '--host', '0.0.0.0'], ['dev', '--workspace', '.', '--host', '::1', '--host', '127.0.0.1'], ['dev', '--workspace', '.', '--origin']]) {
			const result = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
			expect(result.status).toBe(2)
			expect(result.stderr).toContain('uiux: dev requires --workspace <dir> and accepts --host <address> and repeated --origin <url>.')
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

	it('loads the Tailwind and Nuxt UI stylesheet entry for the Workbench', () => {
		expect(nuxtConfig.css).toContain('~/assets/css/main.css')
		const stylesheet = readFileSync(new URL('../app/assets/css/main.css', import.meta.url), 'utf8')
		expect(stylesheet).toContain('@import "tailwindcss";')
		expect(stylesheet).toContain('@import "@nuxt/ui";')
	})

	it('returns a stable, domain-free Nitro health response', () => {
		expect(healthResponse).toEqual({ status: 'ok' })
	})

	it('builds a client-rendered Nuxt app while retaining the Nitro node server', () => {
		expect(nuxtConfig.ssr).toBe(false)
		expect(nuxtConfig.nitro?.preset).toBe('node-server')
	})
})
