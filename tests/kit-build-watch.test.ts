import { describe, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The kit build in watch mode (`kit/build.mjs --watch`, what `uiux dev` runs; issue #402): after any
 * sequence of Kit edits, its `dist/` is byte-identical to a fresh `node build.mjs` of the same sources,
 * so the Adapter content digest of the watch output is one a fresh build reproduces. The dogfood
 * Workspace is only read.
 */

const ROOT = join(import.meta.dirname, '..')
const KIT = join(ROOT, '.uiux', 'kit')
const OUTPUTS = ['uiux.js', 'uiux.css'] as const

// A component whose template holds an HTML comment: `compiler-sfc` compiles it differently the second time
// it compiles the same parsed source, which is what a watch rebuild of an unchanged file does.
const PROBE = `<script setup lang="ts">\nconst label = 'probe'\n</script>\n<template>\n  <!-- a template comment -->\n  <span v-if="label" class="kit-probe">{{ label }}</span>\n</template>\n<style>.kit-probe { color: red; }</style>\n`

async function copyKit(): Promise<string> {
	// Under the repository, so the build resolves the repository's `esbuild` and `vue` as the dogfood kit does.
	const directory = await mkdtemp(join(ROOT, '.uiux-browser-test-kit-'))
	for (const entry of ['adapters', 'src', 'build.mjs', 'package.json']) await cp(join(KIT, entry), join(directory, entry), { recursive: true })
	await writeFile(join(directory, 'src', 'ui', 'Probe.vue'), PROBE)
	return directory
}

const read = (directory: string, relative: string) => readFile(join(directory, relative), 'utf8')
const edit = async (directory: string, relative: string, change: (text: string) => string) => writeFile(join(directory, relative), change(await read(directory, relative)))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function dist(directory: string): Promise<Record<string, string>> {
	return Object.fromEntries(await Promise.all(OUTPUTS.map(async name => [name, await read(directory, `dist/${name}`)] as const)))
}

describe('the kit build in watch mode (issue #402)', () => {
	it('emits, after each edit, the bytes a fresh build of the same sources emits', async () => {
		const watched = await copyKit()
		const fresh = await copyKit()
		let child: ChildProcess | undefined
		try {
			let log = ''
			let builds = 0
			child = spawn(process.execPath, [join(watched, 'build.mjs'), '--watch'], { cwd: watched, stdio: ['ignore', 'pipe', 'pipe'] })
			for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk: Buffer) => {
				log += chunk.toString()
				builds = log.split('build finished').length - 1
			})
			const settle = async (after: number) => {
				const deadline = Date.now() + 30_000
				while (builds <= after) {
					if (Date.now() > deadline) throw new Error(`the watch build did not finish:\n${log}`)
					await sleep(50)
				}
				// A burst of file events can rebuild twice: wait until no further build follows.
				for (let seen = builds; ; seen = builds) {
					await sleep(1000)
					if (builds === seen) break
				}
			}
			const compare = async (step: string) => {
				await rm(join(fresh, 'dist'), { recursive: true, force: true })
				for (const entry of ['adapters', 'src']) {
					await rm(join(fresh, entry), { recursive: true, force: true })
					await cp(join(watched, entry), join(fresh, entry), { recursive: true })
				}
				const result = spawnSync(process.execPath, [join(fresh, 'build.mjs')], { cwd: fresh, encoding: 'utf8' })
				expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
				const [watchOutput, freshOutput] = [await dist(watched), await dist(fresh)]
				for (const name of OUTPUTS) expect(watchOutput[name] === freshOutput[name], `${step}: dist/${name} differs from a fresh build`).toBe(true)
			}
			const step = async (name: string, change?: () => Promise<void>) => {
				const before = builds
				if (change) await change()
				await settle(before)
				await compare(name)
			}

			await step('the first build')
			await step('a Kit component style edit', () => edit(watched, 'src/ui/Badge.vue', text => text.replace('</style>', '.kit-badge-402 { color: red; }\n</style>')))
			await step('a token edit', () => edit(watched, 'src/tokens/tokens.css', text => `${text}\n:root { --kit-402: 1px; }\n`))
			await step('an added import of a component with a template comment', () => edit(watched, 'adapters/reference.ts', text => `import '../src/ui/Probe.vue'\n${text}`))
			await step('an edit of that component', () => edit(watched, 'src/ui/Probe.vue', text => text.replace('color: red', 'color: blue')))
			await step('a removed import', () => edit(watched, 'adapters/reference.ts', text => text.replace(`import '../src/ui/Probe.vue'\n`, '')))
			await step('the style and token edits reverted', async () => {
				await edit(watched, 'src/ui/Badge.vue', text => text.replace('.kit-badge-402 { color: red; }\n', ''))
				await edit(watched, 'src/tokens/tokens.css', text => text.replace('\n:root { --kit-402: 1px; }\n', ''))
			})

			// Back at the dogfood sources, the watch output is the one a build of those sources emits.
			expect(await read(watched, 'src/ui/Badge.vue')).toBe(await readFile(join(KIT, 'src/ui/Badge.vue'), 'utf8'))
		}
		finally {
			child?.kill('SIGKILL')
			await rm(watched, { recursive: true, force: true })
			await rm(fresh, { recursive: true, force: true })
		}
	}, 120_000)
})
