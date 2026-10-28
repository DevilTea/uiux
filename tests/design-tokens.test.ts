import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generate, parseTokens } from '../scripts/design-tokens.mjs'

/**
 * The one token source (Discussion #379, owner answer 5): `.uiux/kit/src/tokens/tokens.css` defines the
 * palette and the semantic tokens once. DESIGN.md's `colors:` front matter and its generated token table
 * come from it (`pnpm design:tokens`), the app maps Nuxt UI onto it, and no palette literal is repeated.
 */

const ROOT = join(import.meta.dirname, '..')
const TOKENS = join(ROOT, '.uiux', 'kit', 'src', 'tokens', 'tokens.css')

async function walk(directory: string, predicate: (path: string) => boolean): Promise<string[]> {
	const found: string[] = []
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name)
		if (entry.isDirectory()) found.push(...await walk(path, predicate))
		else if (predicate(path)) found.push(path)
	}
	return found
}

describe('tokens.css', () => {
	it('is the only place a palette value is written: no other style or component repeats one', async () => {
		const css = await readFile(TOKENS, 'utf8')
		const palette = [...parseTokens(css).get('palette')!].filter(([name]: [string]) => name.startsWith('--color-')).map(([, value]: [string, string]) => value)
		expect(palette.length).toBeGreaterThan(50)
		const files = [
			join(ROOT, 'app', 'assets', 'css', 'main.css'),
			join(ROOT, 'app', 'app.config.ts'),
			join(ROOT, '.uiux', 'kit', 'adapters', 'reference.css'),
			join(ROOT, '.uiux', 'kit', 'adapters', 'reference.ts'),
			...await walk(join(ROOT, '.uiux', 'kit', 'src', 'ui'), path => /\.(vue|ts)$/.test(path)),
			...await walk(join(ROOT, 'app'), path => path.endsWith('.vue')),
		]
		const repeated: string[] = []
		for (const file of files) {
			const text = await readFile(file, 'utf8')
			for (const value of palette) if (text.includes(value)) repeated.push(`${file.slice(ROOT.length + 1)}: ${value}`)
		}
		expect(repeated).toEqual([])
	})

	it('has dark and dark-auto sections that declare the same tokens', async () => {
		const sections = parseTokens(await readFile(TOKENS, 'utf8'))
		const tokens = (name: string) => sections.get(name)!.filter(([token]: [string]) => token.startsWith('--kit-'))
		expect(tokens('dark-auto')).toEqual(tokens('dark'))
		expect(tokens('light').map(([token]: [string]) => token)).toEqual(tokens('dark').map(([token]: [string]) => token))
	})

	it('is mapped by the app: main.css imports the copied tokens and maps Nuxt UI onto them', async () => {
		const main = await readFile(join(ROOT, 'app', 'assets', 'css', 'main.css'), 'utf8')
		expect(main).toContain('@import "../../components/kit/tokens/tokens.css";')
		for (const mapping of ['--ui-primary: var(--kit-primary);', '--ui-error: var(--kit-danger);', '--ui-bg: var(--kit-bg-surface);', '--wb-pin: var(--kit-pin);'])
			expect(main, mapping).toContain(mapping)
		// The copy is the Kit's own file (`uiux components diff --check` guards the drift).
		expect(await readFile(join(ROOT, 'app', 'components', 'kit', 'tokens', 'tokens.css'), 'utf8')).toBe(await readFile(TOKENS, 'utf8'))
	})
})

describe('pnpm design:tokens', () => {
	it('keeps DESIGN.md in step with tokens.css: its colors: block and its generated token table', async () => {
		const [css, design] = await Promise.all([readFile(TOKENS, 'utf8'), readFile(join(ROOT, 'DESIGN.md'), 'utf8')])
		expect(generate(css, design)).toBe(design)
		expect(design).toContain('<!-- generated:tokens -->')
		expect(design).toMatch(/\n {2}iris-600: "oklch\(52\.6% 0\.205 293\.6\)"\n/)
		// sRGB hex from the OKLCH value, as the hand-written table it replaced gave them.
		expect(design).toContain('| `--kit-primary` | `iris-600` #7545d3 | `iris-400` #a78bfa |')
	})

	it('regenerates the colors: block and the table from a changed palette value, and nothing else', async () => {
		const [css, design] = await Promise.all([readFile(TOKENS, 'utf8'), readFile(join(ROOT, 'DESIGN.md'), 'utf8')])
		const changed = generate(css.replace('--color-iris-600: oklch(52.6% 0.205 293.6);', '--color-iris-600: oklch(50% 0.2 280);'), design)
		const before = design.split('\n')
		const after = changed.split('\n')
		const differing = after.filter((line: string) => !before.includes(line))
		expect(differing.some((line: string) => line.includes('iris-600: "oklch(50% 0.2 280)"'))).toBe(true)
		expect(differing.some((line: string) => line.startsWith('| `--kit-primary` |'))).toBe(true)
		// Every changed line is a palette entry or a token row; the prose and the hand-written front matter stay.
		for (const line of differing) expect(line).toMatch(/^( {2}[a-z0-9-]+: "oklch|\| `--kit-)/)
	})

	it('refuses a tokens.css whose dark-auto section drifted from dark', async () => {
		const [css, design] = await Promise.all([readFile(TOKENS, 'utf8'), readFile(join(ROOT, 'DESIGN.md'), 'utf8')])
		const index = css.lastIndexOf('--kit-primary: var(--color-iris-400);')
		expect(index).toBeGreaterThan(0)
		const drifted = `${css.slice(0, index)}--kit-primary: var(--color-iris-300);${css.slice(index + '--kit-primary: var(--color-iris-400);'.length)}`
		expect(() => generate(drifted, design)).toThrow(/dark and dark-auto sections differ at --kit-primary/)
	})

	it('--check exits 0 when DESIGN.md matches and 1, naming the command, when it does not', async () => {
		const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'design-tokens.mjs'), ...args], { encoding: 'utf8', env })
		expect(run(['--check']).status).toBe(0)
		// A private copy of the repository files the script reads, with one drifted palette value.
		const directory = await mkdtemp(join(tmpdir(), 'uiux-design-tokens-'))
		try {
			await mkdir(join(directory, 'scripts'), { recursive: true })
			await mkdir(join(directory, '.uiux', 'kit', 'src', 'tokens'), { recursive: true })
			await cp(join(ROOT, 'scripts', 'design-tokens.mjs'), join(directory, 'scripts', 'design-tokens.mjs'))
			await cp(TOKENS, join(directory, '.uiux', 'kit', 'src', 'tokens', 'tokens.css'))
			const design = await readFile(join(ROOT, 'DESIGN.md'), 'utf8')
			await writeFile(join(directory, 'DESIGN.md'), design.replace('iris-600: "oklch(52.6% 0.205 293.6)"', 'iris-600: "oklch(1% 0 0)"'))
			const drifted = spawnSync(process.execPath, [join(directory, 'scripts', 'design-tokens.mjs'), '--check'], { encoding: 'utf8' })
			expect(drifted.status).toBe(1)
			expect(drifted.stderr).toContain('pnpm design:tokens')
		}
		finally {
			await rm(directory, { recursive: true, force: true })
		}
	})
})
