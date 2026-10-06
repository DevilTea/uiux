import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

function walk(dir: string, predicate: (path: string) => boolean): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry)
		if (statSync(path).isDirectory()) return walk(path, predicate)
		return predicate(path) ? [path] : []
	})
}

describe('Workbench theme tokens (DESIGN.md "The Quiet Canvas")', () => {
	const vueFiles = walk(join(ROOT, 'app'), path => path.endsWith('.vue'))

	it('uses semantic tokens instead of hard-coded palette classes or dark: variants', () => {
		const offenders: string[] = []
		for (const file of vueFiles) {
			readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
				if (/(neutral|slate|gray|green|emerald|amber|red|blue|violet)-[0-9]/.test(line) || /\bdark:/.test(line))
					offenders.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`)
			})
		}
		expect(offenders).toEqual([])
	})

	it('never sizes chrome text below the 12px floor with arbitrary values', () => {
		const offenders: string[] = []
		for (const file of vueFiles) {
			for (const match of readFileSync(file, 'utf8').matchAll(/text-\[(\d+(?:\.\d+)?)(px|rem)\]/g)) {
				const px = match[2] === 'rem' ? Number(match[1]) * 16 : Number(match[1])
				if (px < 12) offenders.push(`${relative(ROOT, file)}: ${match[0]}`)
			}
		}
		expect(offenders).toEqual([])
	})

	it('maps Nuxt UI roles to the Iris / Marker / Leaf / Graphite ramps', () => {
		const appConfig = readFileSync(join(ROOT, 'app', 'app.config.ts'), 'utf8')
		expect(appConfig).not.toMatch(/primary:\s*'green'/)
		expect(appConfig).toMatch(/primary:\s*'iris'/)
		expect(appConfig).toMatch(/annotation:\s*'marker'/)
		expect(appConfig).toMatch(/success:\s*'leaf'/)
		expect(appConfig).toMatch(/neutral:\s*'graphite'/)
		const nuxtConfig = readFileSync(join(ROOT, 'nuxt.config.ts'), 'utf8')
		expect(nuxtConfig).toMatch(/colors:\s*\[[^\]]*'annotation'/)
	})

	it('bundles Inter and JetBrains Mono into the build output with no remote font URLs', () => {
		const assets = join(ROOT, '.output', 'public', '_nuxt')
		expect(existsSync(assets), 'run pnpm build first').toBe(true)
		const files = readdirSync(assets)
		expect(files.some(file => /^inter-latin-wght-normal\..+\.woff2$/.test(file))).toBe(true)
		expect(files.some(file => /^jetbrains-mono-latin-400-normal\..+\.woff2$/.test(file))).toBe(true)
		const css = files.filter(file => file.endsWith('.css')).map(file => readFileSync(join(assets, file), 'utf8')).join('\n')
		const fontFaces = css.match(/@font-face\{[^}]*\}/g) ?? []
		expect(fontFaces.length).toBeGreaterThan(0)
		for (const face of fontFaces) expect(face).not.toMatch(/url\((["']?)(https?:)?\/\//)
	})
})
