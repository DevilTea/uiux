import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { installLogRedaction } from '../src/server/access/redaction'

// Issue #290, Rule 01a11485-ed17-791a-a30e-1b63fa6f16ce: the console redaction is installed before
// any Nitro plugin can log, so a startup diagnostic never reaches the console unredacted.
const pluginsDir = resolve(import.meta.dirname, '../server/plugins')
// Imported by a computed path: the plugin uses Nitro's auto-imported `defineNitroPlugin`, which the test project's types do not declare.
const pluginPath = resolve(pluginsDir, '00-log-redaction.ts')

describe('log redaction at startup', () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('loads the redaction plugin before every other server plugin', () => {
		const plugins = readdirSync(pluginsDir).sort()
		expect(plugins[0]).toBe('00-log-redaction.ts')
		expect(plugins).toContain('loopback-guard.ts')
		expect(plugins).toContain('selected-workspace.ts')
	})

	it('redacts a message logged right after the first plugin has run', async () => {
		let run: (() => void) | undefined
		vi.stubGlobal('defineNitroPlugin', (plugin: () => void) => {
			run = plugin
			return plugin
		})
		const written: unknown[][] = []
		const original = console.error
		console.error = (...args: unknown[]) => { written.push(args) }
		try {
			const { diagnostics } = await import('../src/logging/diagnostics')
			await import(/* @vite-ignore */ pluginPath)
			run?.()
			diagnostics.error('uiux: startup failed with Authorization: Bearer abcdef0123456789abcdef0123456789')
		}
		finally {
			installLogRedaction()()
			console.error = original
		}
		expect(written).toHaveLength(1)
		expect(String(written[0]![0])).not.toContain('abcdef0123456789abcdef0123456789')
	})
})
