import { lstat, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { isSafeRelativePath } from '../domain/validation'
import { KIT_PACKAGE_FILENAME } from './kit-dependencies'

/**
 * The kit project's build declaration (Clause 01a11bb1-86af-7d2c-946e-6217b40c8ad3): the top-level
 * `uiux` object `{ output, build }` of `kit/package.json`, a host file that no Workbench action, HTTP
 * request or MCP Tool writes (Rule 01a11bb1-9d17-7205-abee-c2aa7058c107). `command` and `watch` are
 * argument arrays, an executable followed by its arguments, never a shell string.
 */
export type KitBuildDeclaration = Readonly<{
	/** The build output directory, relative to `kit/`, normalized (no `./` prefix or trailing `/`). */
	output: string
	command: readonly string[]
	watch?: readonly string[]
	timeoutSeconds: number
}>

export type KitBuildDeclarationRead =
	| Readonly<{ state: 'none' }>
	| Readonly<{ state: 'declared'; declaration: KitBuildDeclaration }>
	| Readonly<{ state: 'invalid'; message: string }>

export const KIT_BUILD_DEFAULT_TIMEOUT_SECONDS = 300
export const KIT_BUILD_MAX_TIMEOUT_SECONDS = 3600

const UIUX_MEMBERS = new Set(['output', 'build'])
const BUILD_MEMBERS = new Set(['command', 'watch', 'timeoutSeconds'])

/**
 * The build declaration of the kit project at `codeDirectory`. A kit without `package.json`, or one
 * without a `uiux` member, declares no build (the minimal form). A package file that is not a
 * regular file (a symbolic link included) or not well formed, and a malformed `uiux` member, are
 * `invalid`: no command is run on a guess. Messages name only kit-relative paths.
 */
export async function readKitBuildDeclaration(codeDirectory: string): Promise<KitBuildDeclarationRead> {
	return (await readKitBuildDeclarationOnce(codeDirectory)).read
}

/** How many reads of `kit/package.json` `readDeclaredKitBuildDeclaration` makes at most, and how far apart. */
export const KIT_BUILD_DECLARATION_READ_ATTEMPTS = 4
export const KIT_BUILD_DECLARATION_RETRY_DELAY_MS = 50

/**
 * The build declaration of a kit project whose build is known to be declared, such as one whose
 * build output is being captured (Rule 01a11bb1-9e5e-79ab-841e-c953e8b44bbf). A host may rewrite
 * `kit/package.json` non-atomically (truncate, then write), so a read that finds the file missing,
 * unreadable or not well formed JSON is repeated, at most `KIT_BUILD_DECLARATION_READ_ATTEMPTS` reads
 * in all, `KIT_BUILD_DECLARATION_RETRY_DELAY_MS` apart; the last read stands, with its own message.
 * A well formed file with a malformed `uiux` member, and a package file that is not a regular file,
 * are not read again.
 */
export async function readDeclaredKitBuildDeclaration(codeDirectory: string): Promise<KitBuildDeclarationRead> {
	let attempt = await readKitBuildDeclarationOnce(codeDirectory)
	for (let reads = 1; attempt.unreadable && reads < KIT_BUILD_DECLARATION_READ_ATTEMPTS; reads++) {
		await new Promise(resolve => setTimeout(resolve, KIT_BUILD_DECLARATION_RETRY_DELAY_MS))
		attempt = await readKitBuildDeclarationOnce(codeDirectory)
	}
	return attempt.read
}

/** One read of `kit/package.json`; `unreadable` when its content could not be had, as while a host rewrites it. */
async function readKitBuildDeclarationOnce(codeDirectory: string): Promise<Readonly<{ read: KitBuildDeclarationRead; unreadable: boolean }>> {
	const path = join(codeDirectory, KIT_PACKAGE_FILENAME)
	const unreadable = (read: KitBuildDeclarationRead) => ({ read, unreadable: true })
	let info: Awaited<ReturnType<typeof lstat>>
	try {
		info = await lstat(path)
	}
	catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code
		if (code === 'ENOENT' || code === 'ENOTDIR') return unreadable({ state: 'none' })
		return unreadable({ state: 'invalid', message: `kit/${KIT_PACKAGE_FILENAME} could not be read.` })
	}
	if (!info.isFile()) return { read: { state: 'invalid', message: `kit/${KIT_PACKAGE_FILENAME} is not a regular file.` }, unreadable: false }
	let text: string
	try {
		text = await readFile(path, 'utf8')
	}
	catch {
		return unreadable({ state: 'invalid', message: `kit/${KIT_PACKAGE_FILENAME} could not be read.` })
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	}
	catch {
		return unreadable({ state: 'invalid', message: `kit/${KIT_PACKAGE_FILENAME} could not be read as JSON.` })
	}
	return { read: parseKitBuildDeclaration(parsed), unreadable: false }
}

/** The build declaration of a parsed `kit/package.json`. */
export function parseKitBuildDeclaration(packageJson: unknown): KitBuildDeclarationRead {
	const invalid = (message: string): KitBuildDeclarationRead => ({ state: 'invalid', message: `kit/${KIT_PACKAGE_FILENAME} uiux: ${message}` })
	if (!isPlainObject(packageJson)) return { state: 'invalid', message: `kit/${KIT_PACKAGE_FILENAME} is not a JSON object.` }
	if (!Object.hasOwn(packageJson, 'uiux')) return { state: 'none' }
	const uiux = packageJson.uiux
	if (!isPlainObject(uiux)) return invalid('must be an object { output, build }.')
	const unknownMember = Object.keys(uiux).find(name => !UIUX_MEMBERS.has(name))
	if (unknownMember !== undefined) return invalid(`unknown member ${JSON.stringify(unknownMember)}; it holds { output, build }.`)

	const output = normalizeOutput(uiux.output)
	if (output === undefined) return invalid('output must be a directory relative to kit/, inside it and outside kit/node_modules/.')

	const build = uiux.build
	if (!isPlainObject(build)) return invalid('build must be an object { command, watch?, timeoutSeconds? }.')
	const unknownBuildMember = Object.keys(build).find(name => !BUILD_MEMBERS.has(name))
	if (unknownBuildMember !== undefined) return invalid(`unknown build member ${JSON.stringify(unknownBuildMember)}; it holds { command, watch?, timeoutSeconds? }.`)
	const command = argumentArray(build.command)
	if (!command) return invalid('build.command must be a non-empty array of strings, an executable followed by its arguments, never a shell string.')
	let watch: readonly string[] | undefined
	if (build.watch !== undefined) {
		watch = argumentArray(build.watch)
		if (!watch) return invalid('build.watch must be a non-empty array of strings, an executable followed by its arguments, never a shell string.')
	}
	let timeoutSeconds = KIT_BUILD_DEFAULT_TIMEOUT_SECONDS
	if (build.timeoutSeconds !== undefined) {
		const value = build.timeoutSeconds
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > KIT_BUILD_MAX_TIMEOUT_SECONDS)
			return invalid(`build.timeoutSeconds must be an integer from 1 to ${KIT_BUILD_MAX_TIMEOUT_SECONDS}.`)
		timeoutSeconds = value
	}
	return { state: 'declared', declaration: Object.freeze({ output, command, ...(watch ? { watch } : {}), timeoutSeconds }) }
}

/**
 * Whether the `./` Adapter specifier `moduleSpecifier`, as written, names a file inside the build
 * output directory `output` (Clause 01a11bb1-8721-721e-80b6-3cffed19e5ef).
 */
export function specifierInBuildOutput(moduleSpecifier: string, output: string): boolean {
	if (!moduleSpecifier.startsWith('./')) return false
	const authored = posix.normalize(moduleSpecifier.slice(2))
	return authored.startsWith(`${output}/`) && authored.length > output.length + 1
}

function normalizeOutput(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	let path = value
	if (path.startsWith('./')) path = path.slice(2)
	if (path.endsWith('/')) path = path.slice(0, -1)
	if (!isSafeRelativePath(path)) return undefined
	if ((path.split('/')[0] ?? '').toLowerCase() === 'node_modules') return undefined
	return path
}

/** A non-empty array of strings whose first element, the executable, is non-empty; no string holds a NUL. */
function argumentArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined
	if (!value.every(item => typeof item === 'string' && !item.includes('\0'))) return undefined
	if ((value[0] as string).length === 0) return undefined
	return Object.freeze([...value as string[]])
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
