import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { checkProductKitAgainstKit, scanImportSpecifiers } from '../src/adapters/kit-registry'
import { readKitBuildDeclaration, specifierInBuildOutput } from '../src/adapters/kit-build-declaration'
import { declaredInterface } from '../src/domain/product-kit/component-interface'
import { validateProductKit } from '../src/domain/product-kit/schema'

/**
 * The dogfood Workspace's Kit (Discussion #379 D1, issue #380): Kit components in `.uiux/kit/src/ui/`,
 * the one token source `.uiux/kit/src/tokens/tokens.css`, the kit build, and the reference Adapter that
 * wraps the components. The dogfood Workspace is only read.
 */

const ROOT = join(import.meta.dirname, '..')
const WORKSPACE = join(ROOT, '.uiux')
const KIT = join(WORKSPACE, 'kit')
const COMPONENTS = ['badge', 'button', 'comment-pin', 'field', 'icon', 'kbd', 'tokens'] as const

async function productKit() {
	const validation = validateProductKit(JSON.parse(await readFile(join(WORKSPACE, 'product-kit.json'), 'utf8')))
	if (!validation.ok) throw new Error(`product-kit.json is invalid: ${JSON.stringify(validation.diagnostics)}`)
	return validation.value
}

async function uiFiles(): Promise<string[]> {
	return (await readdir(join(KIT, 'src', 'ui'))).filter(name => name.endsWith('.vue')).sort()
}

describe('the dogfood Product Kit registry', () => {
	it('declares the Kit components, each as a design-system component, and a build whose output holds the Adapter', async () => {
		const kit = await productKit()
		expect(Object.keys(kit.components).sort()).toEqual([...COMPONENTS])
		for (const component of Object.values(kit.components)) expect(component.layer).toBe('design-system')
		const build = await readKitBuildDeclaration(KIT)
		expect(build.state).toBe('declared')
		if (build.state !== 'declared') return
		// Clause 01a11bb1-8721-721e-80b6-3cffed19e5ef: with a build, every `./` Adapter lies in its output.
		expect(kit.adapters.map(adapter => adapter.moduleSpecifier)).toEqual(['./dist/uiux.js'])
		for (const adapter of kit.adapters) expect(specifierInBuildOutput(adapter.moduleSpecifier, build.declaration.output)).toBe(true)
	})

	it('passes the registry validation and the best-effort import scan with no refusal and no finding (Rule 01a11bb1-a310-70a6-9f9b-c87ec2bcfaf9)', async () => {
		const checked = await checkProductKitAgainstKit({ root: WORKSPACE, codeDirectoryName: 'kit', next: await productKit() })
		expect(checked).toEqual({ refusals: [], findings: [] })
	})

	it('maps the Widget types the Kit components back to the reference Adapter\'s Widgets', async () => {
		const kit = await productKit()
		expect(kit.widgets).toEqual({
			Badge: { component: 'badge' },
			Button: { component: 'button' },
			Pin: { component: 'comment-pin' },
			TextInput: { component: 'field' },
		})
	})
})

describe('Kit components', () => {
	it('import only vue and kit-relative files, with no app context: no router, i18n, store or Nuxt', async () => {
		for (const name of await uiFiles()) {
			const source = await readFile(join(KIT, 'src', 'ui', name), 'utf8')
			for (const specifier of scanImportSpecifiers(source))
				expect(specifier === 'vue' || specifier.startsWith('./') || specifier.startsWith('../'), `${name} imports ${specifier}`).toBe(true)
			expect(source, name).not.toMatch(/\b(useI18n|useRoute|useRouter|useNuxtApp|useState|\$fetch|useFetch)\b|#imports|@nuxt\//)
		}
	})

	it('are controlled: each declares props or emits (Clause 01a11bb1-8980-7212-acad-4145928e5dc7, Rule 01a11bb1-a827-75e3-b05f-4099146cff2a)', async () => {
		for (const name of await uiFiles()) {
			const declared = declaredInterface(name, await readFile(join(KIT, 'src', 'ui', name), 'utf8'))
			expect(declared.props || declared.emits, name).toBe(true)
		}
	})

	it('read only `--kit-*` tokens: no palette `--color-*` variable, which belongs to tokens.css', async () => {
		for (const name of await uiFiles()) expect(await readFile(join(KIT, 'src', 'ui', name), 'utf8'), name).not.toMatch(/var\(--color-/)
	})

	it('read only tokens that tokens.css declares, or declare them themselves', async () => {
		const tokens = await readFile(join(KIT, 'src', 'tokens', 'tokens.css'), 'utf8')
		const declared = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(match => match[1]))
		const files = [
			...(await uiFiles()).map(name => join(KIT, 'src', 'ui', name)),
			join(KIT, 'adapters', 'reference.css'),
		]
		for (const file of files) {
			const css = await readFile(file, 'utf8')
			for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) declared.add(match[1]!)
		}
		const unknown: string[] = []
		for (const file of files) {
			for (const match of (await readFile(file, 'utf8')).matchAll(/var\((--[a-z0-9-]+)\s*([,)])/g)) {
				// `var(--x, fallback)` is a deliberate hook (such as `--kit-target-min`); only a bare `var(--x)` must resolve.
				if (match[2] === ')' && !declared.has(match[1]!)) unknown.push(`${file.slice(ROOT.length + 1)}: ${match[1]}`)
			}
		}
		expect(unknown).toEqual([])
	})
})

describe('the kit build (kit/build.mjs)', () => {
	async function copyKit(): Promise<string> {
		// Under the repository, so the build resolves the repository's `esbuild` and `vue` as the dogfood kit does.
		const directory = await mkdtemp(join(ROOT, '.uiux-browser-test-kit-'))
		for (const entry of ['adapters', 'src', 'build.mjs', 'package.json']) await cp(join(KIT, entry), join(directory, entry), { recursive: true })
		return directory
	}
	const build = (directory: string) => spawnSync(process.execPath, [join(directory, 'build.mjs')], { encoding: 'utf8' })

	it('emits the wrapper entry and one stylesheet, deterministically and with no host path in them', async () => {
		const directory = await copyKit()
		try {
			expect(build(directory).status).toBe(0)
			const first = await Promise.all(['uiux.js', 'uiux.css'].map(name => readFile(join(directory, 'dist', name), 'utf8')))
			expect(await readdir(join(directory, 'dist'))).toEqual(['uiux.css', 'uiux.js'])
			expect(build(directory).status).toBe(0)
			const second = await Promise.all(['uiux.js', 'uiux.css'].map(name => readFile(join(directory, 'dist', name), 'utf8')))
			expect(second).toEqual(first)
			const [script, css] = first as [string, string]
			// The module links its stylesheet, so the Adapter module graph (and its content digest) includes it.
			expect(script.startsWith('import "./uiux.css";')).toBe(true)
			// vue and the host packages stay external: the Preview and the server supply them.
			expect(script).toMatch(/from "vue"/)
			expect(script).toMatch(/from "@deviltea\/widget-core"/)
			for (const text of [script, css]) {
				expect(text).not.toContain(ROOT)
				expect(text).not.toContain(directory)
			}
			for (const selector of ['.kit-btn', '.kit-badge', '.kit-comment-pin', '.kit-field', '--color-iris-600', '--kit-primary'])
				expect(css, selector).toContain(selector)
		}
		finally {
			await rm(directory, { recursive: true, force: true })
		}
	}, 60_000)

	const SCRIPT = `<script setup lang="ts">\nconst color = 'red'\ndefineProps<{ label?: string }>()\n</script>\n<template><div>{{ color }}</div></template>\n`
	it.each([
		['a scoped style', '<style scoped>.a { color: red; }</style>', '<style scoped> is not supported'],
		['a CSS module', '<style module>.a { color: red; }</style>', '<style module> is not supported'],
		['a preprocessor style', '<style lang="scss">.a { color: red; }</style>', '<style lang="scss"> is not supported'],
		['an external style', '<style src="./x.css"></style>', '<style src> is not supported'],
		['CSS v-bind()', '<style>.a { color: v-bind(color); }</style>', 'CSS v-bind() (color) is not supported'],
	])('fails the build, naming the file and the problem, for %s', async (_name, style, message) => {
		const directory = await copyKit()
		try {
			await writeFile(join(directory, 'src', 'ui', 'Unsupported.vue'), `${SCRIPT}${style}\n`)
			await writeFile(join(directory, 'adapters', 'reference.ts'), `import Unsupported from '../src/ui/Unsupported.vue'\nexport default Unsupported\n`)
			const result = build(directory)
			expect(result.status).not.toBe(0)
			expect(`${result.stdout}${result.stderr}`).toContain('src/ui/Unsupported.vue')
			expect(`${result.stdout}${result.stderr}`).toContain(message)
		}
		finally {
			await rm(directory, { recursive: true, force: true })
		}
	}, 60_000)

	it('fails with a nonzero status on a component that does not compile', async () => {
		const directory = await copyKit()
		try {
			await writeFile(join(directory, 'src', 'ui', 'Broken.vue'), '<template><div></template>\n')
			await writeFile(join(directory, 'adapters', 'reference.ts'), `import Broken from '../src/ui/Broken.vue'\nexport default Broken\n`)
			const result = build(directory)
			expect(result.status).not.toBe(0)
		}
		finally {
			await rm(directory, { recursive: true, force: true })
		}
	}, 60_000)
})

describe('the app consumes the Kit through uiux components', () => {
	it('has no drift: `uiux components diff --check` exits 0 for the app (issue #380)', () => {
		// The command reads `.uiux/` and the product project's `uiux-components.json`; it writes nothing.
		const output = execFileSync(process.execPath, [join(ROOT, 'bin', 'uiux.mjs'), 'components', 'diff', '--check', '--workspace', WORKSPACE], { cwd: ROOT, encoding: 'utf8' })
		expect(output).toContain('Every recorded file is unchanged.')
	})
})
