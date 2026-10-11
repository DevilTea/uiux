import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { emptyProductKit } from '../domain/product-kit/schema'
import { LEGACY_LAYOUT, V5_LAYOUT } from '../persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, WORKSPACE_GITIGNORE_RULES } from '../product/workspace-schema'

export type InitCommandOptions = Readonly<{
	/** `--workspace <dir>` as given; omitted, the default location is used. */
	workspace?: string
	cwd?: string
	stdout?: (line: string) => void
	stderr?: (line: string) => void
	/** Test seam: the Git toplevel of `cwd`, or `undefined` outside a Git repository. */
	gitToplevel?: (cwd: string) => string | undefined
}>

/**
 * `uiux init [--workspace <dir>]` (Clauses 01a1144e-55a3-74c4-8bf8-3205e968e275 and
 * 01a1144e-55be-785d-b494-7f7da834572a): creates a minimal current-schema Workspace in `<dir>`, by
 * default `<git toplevel>/.uiux/` inside a Git repository and `<cwd>/.uiux/` otherwise. `<dir>`
 * holds the manifest directly. It writes `workspace.json` (a `defaultLocale`, empty viewport and
 * theme registries), a `product-kit.json` whose members are all empty, and a `.gitignore` listing
 * the runtime files, `kit/node_modules/` and `kit/dist/`; an existing `.gitignore` keeps its lines
 * and gains only the missing rules. The manifest is written last, so an interrupted run never
 * leaves a directory that looks initialized.
 *
 * It refuses, changing nothing, a directory whose manifest already exists, including an old-layout
 * Workspace root whose manifest is in `.uiux/`. Returns 0 on success, 2 when refused.
 */
export async function runInitCommand(options: InitCommandOptions = {}): Promise<number> {
	const out = options.stdout ?? (line => console.log(line))
	const err = options.stderr ?? (line => console.error(line))
	const cwd = resolve(options.cwd ?? process.cwd())
	const root = options.workspace === undefined
		? join((options.gitToplevel ?? gitToplevel)(cwd) ?? cwd, LEGACY_LAYOUT.metadataDir)
		: resolve(cwd, options.workspace)

	try {
		if (!(await stat(root)).isDirectory()) {
			err(`uiux: Workspace root is not a directory: ${root}`)
			return 2
		}
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
		await mkdir(root, { recursive: true })
	}

	for (const manifest of [V5_LAYOUT.manifestPath, LEGACY_LAYOUT.manifestPath]) {
		const path = join(root, ...manifest.split('/'))
		if (await exists(path)) {
			err(`uiux: Workspace is already initialized: ${path}`)
			return 2
		}
	}
	const productKitPath = join(root, V5_LAYOUT.productKitPath!)
	if (await exists(productKitPath)) {
		err(`uiux: ${root} already holds ${V5_LAYOUT.productKitPath}; remove it or choose another directory.`)
		return 2
	}

	const manifest = {
		schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		i18n: { defaultLocale: 'en-US' },
		viewports: {},
		themes: {},
	}
	await writeFile(productKitPath, json(emptyProductKit()), { encoding: 'utf8', flag: 'wx' })
	await writeGitignore(join(root, '.gitignore'))
	try {
		await writeFile(join(root, V5_LAYOUT.manifestPath), json(manifest), { encoding: 'utf8', flag: 'wx' })
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error
		err(`uiux: Workspace is already initialized: ${join(root, V5_LAYOUT.manifestPath)}`)
		return 2
	}

	out(`Initialized UIUX Workspace at ${root}`)
	out(basename(root) === LEGACY_LAYOUT.metadataDir
		? `  Start it with: uiux dev (from ${resolve(root, '..')} or below), or uiux dev --workspace ${root}`
		: `  Start it with: uiux dev --workspace ${root}`)
	return 0
}

/** Writes the rules into a new `.gitignore`, or appends the missing ones to an existing file. */
async function writeGitignore(path: string): Promise<void> {
	let existing: string | undefined
	try {
		const entry = await lstat(path)
		if (!entry.isFile()) throw new Error(`${path} is not a regular file.`)
		existing = await readFile(path, 'utf8')
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error
	}
	if (existing === undefined) {
		await writeFile(path, `${WORKSPACE_GITIGNORE_RULES.join('\n')}\n`, { encoding: 'utf8', flag: 'wx' })
		return
	}
	const present = new Set(existing.split(/\r?\n/u).map(line => line.trim()))
	const missing = WORKSPACE_GITIGNORE_RULES.filter(rule => !present.has(rule))
	if (missing.length === 0) return
	const separator = existing === '' || existing.endsWith('\n') ? '' : '\n'
	await writeFile(path, `${existing}${separator}${missing.join('\n')}\n`, 'utf8')
}

/** The Git toplevel of `cwd`, or `undefined` outside a Git repository or without Git. */
function gitToplevel(cwd: string): string | undefined {
	const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
	const toplevel = result.status === 0 ? result.stdout.trim() : ''
	return toplevel === '' ? undefined : resolve(toplevel)
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path)
		return true
	}
	catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code
		if (code === 'ENOENT' || code === 'ENOTDIR') return false
		throw error
	}
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`
}
