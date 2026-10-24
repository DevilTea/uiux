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
		['src/server/example.ts', 'globalThis.process.stdout.write(\'x\')\n'],
		['src/server/example.ts', 'global.console.log(\'x\')\n'],
		['src/server/example.ts', 'process[\'stdout\'].write(\'x\')\n'],
		['src/server/example.ts', 'process["stderr"].write(\'x\')\n'],
		['src/persistence/example.ts', 'const { log } = console\nlog(\'x\')\n'],
		['bin/example.mjs', 'console.error(\'x\')\n'],
		// Issue #290: aliases, modules, file descriptors and inherited stdio.
		['src/server/example.ts', 'const c = globalThis\nexport { c }\n'],
		['src/server/example.ts', 'const { console: c } = globalThis\nexport { c }\n'],
		['src/server/example.ts', 'let g\ng = global\nexport { g }\n'],
		['src/server/example.ts', 'globalThis[\'console\'].log(\'x\')\n'],
		['src/server/example.ts', 'import { log } from \'node:console\'\nlog(\'x\')\n'],
		['src/server/example.ts', 'import { log } from \'console\'\nlog(\'x\')\n'],
		['src/server/example.ts', 'await import(\'node:console\')\n'],
		['src/adapter-entry/index.js', 'require(\'node:console\').log(\'x\')\n'],
		['src/server/example.ts', 'import p from \'node:process\'\np.stdout.write(\'x\')\n'],
		['src/server/example.ts', 'import * as p from \'node:process\'\np.stdout.write(\'x\')\n'],
		['src/server/example.ts', 'import { stderr } from \'node:process\'\nstderr.write(\'x\')\n'],
		['src/server/example.ts', 'import process from \'node:process\'\nprocess.stdout.write(\'x\')\n'],
		['src/server/example.ts', 'import fs from \'node:fs\'\nfs.writeSync(1, \'x\')\n'],
		['src/server/example.ts', 'import { writeSync } from \'node:fs\'\nwriteSync(2, \'x\')\n'],
		['src/server/example.ts', 'import { writeFileSync } from \'node:fs\'\nwriteFileSync(\'/dev/stdout\', \'x\')\n'],
		['src/server/example.ts', 'import { spawn } from \'node:child_process\'\nspawn(\'x\', [], { stdio: \'inherit\' })\n'],
		['src/server/example.ts', 'import { spawn } from \'node:child_process\'\nspawn(\'x\', [], { stdio: [\'ignore\', \'inherit\', \'pipe\'] })\n'],
		['server/plugins/example.js', 'console.log(\'x\')\n'],
		['server/plugins/example.vue', '<script>\nprocess.stdout.write(\'x\')\n</script>\n'],
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
		expect(await lint(file, 'import fs from \'node:fs\'\nconsole.log(\'x\')\nprocess.stdout.write(\'x\')\nfs.writeSync(1, \'x\')\n')).toEqual([])
	})

	it('allows non-stdio file descriptors, piped stdio and the plain process import', async () => {
		const code = 'import fs from \'node:fs\'\nimport process from \'node:process\'\nimport { spawn } from \'node:child_process\'\nfs.writeSync(3, \'x\')\nspawn(\'x\', [], { stdio: [\'ignore\', \'pipe\', \'pipe\'] })\nexport const cwd = process.cwd()\n'
		expect(await lint('src/server/example.ts', code)).toEqual([])
	})

	it('does not reject process.stdin or process.exitCode', async () => {
		expect(await lint('src/server/example.ts', 'process.stdin.setEncoding(\'utf8\')\nprocess.exitCode = 1\n')).toEqual([])
	})

	it('leaves tests and scripts unrestricted', async () => {
		expect(await lint('tests/example.test.ts', 'console.log(\'x\')\n')).toEqual([])
		expect(await lint('scripts/example.mjs', 'process.stdout.write(\'x\')\n')).toEqual([])
	})
})
