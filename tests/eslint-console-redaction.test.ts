import { resolve } from 'node:path'

import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// Issue #169, Rule 01a11485-ed17-791a-a30e-1b63fa6f16ce: raw console and stdio writes are
// rejected outside the sanctioned writer modules, so log output cannot bypass redaction.
const root = resolve(import.meta.dirname, '..')
const eslint = new ESLint({ cwd: root })

async function lint(filePath: string, code: string): Promise<string[]> {
	const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) })
	return (result?.messages ?? []).map(message => message.ruleId ?? 'parse-error')
}

describe('raw console and stdio restriction', () => {
	it('rejects a raw console.log in a server module', async () => {
		expect(await lint('server/plugins/example.ts', 'console.log(\'x\')\n')).toContain('no-console')
	})

	it.each([
		['src/server/example.ts', 'process.stdout.write(\'x\')\n'],
		['src/server/example.ts', 'process.stderr.write(\'x\')\n'],
		['src/server/example.ts', 'globalThis.console.table([])\n'],
		['src/persistence/example.ts', 'const { log } = console\nlog(\'x\')\n'],
		['bin/example.mjs', 'console.error(\'x\')\n'],
	])('rejects %s: %s', async (file, code) => {
		const rules = await lint(file, code)
		expect(rules.some(rule => rule === 'no-console' || rule === 'no-restricted-syntax')).toBe(true)
	})

	it.each([
		'src/logging/diagnostics.ts',
		'src/cli/output.ts',
		'src/server/access/redaction.ts',
		'bin/uiux.mjs',
	])('allows the sanctioned writer %s', async (file) => {
		expect(await lint(file, 'console.log(\'x\')\nprocess.stdout.write(\'x\')\n')).toEqual([])
	})

	it('leaves tests and scripts unrestricted', async () => {
		expect(await lint('tests/example.test.ts', 'console.log(\'x\')\n')).toEqual([])
		expect(await lint('scripts/example.mjs', 'process.stdout.write(\'x\')\n')).toEqual([])
	})
})
