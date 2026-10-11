import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { canonicalJsonStringify } from '../domain/canonical-json'
import type { ProductKit } from '../domain/product-kit/schema'
import { jsonPointer, type Diagnostic } from '../domain/validation'
import { bareKitSpecifierProblem, bareSpecifierPackageName, readDeclaredKitDependencies, relativeKitSpecifierProblem } from './kit-dependencies'
import { realDirectoryIdentity } from './resolution'

/**
 * The checks of the Product Kit file that need the kit project (`kit/`): what the file's own
 * validator (`validateProductKit`) cannot decide. The Product Kit authoring operations run them
 * before storing a change (`refusals`), and the Product Kit read reports them as findings.
 *
 * - Adapter and `styles` specifiers follow the kit project's specifier rules, as written
 *   (Clauses 01a115cd-d109-76d3-9622-85d0080c60b6 and 01a11bb1-8787-786a-a87e-49672393abd1).
 * - `designSystems` and each component's `packages` are dependencies `kit/package.json` declares
 *   (Rule 01a11bb1-a120-70a9-a875-3842da36c587, Clause 01a11bb1-8a44-793a-8306-21fea501acad).
 * - Registry validation (Rule 01a11bb1-a2ac-754e-97c8-4f118218a051): every file a component
 *   declares is a regular file under `kit/src/`, by its real path, and none is a wrapper entry,
 *   until the kit build (K7) the module of a `./` Adapter (Clause 01a11bb1-89e2-75f8-8131-97b0a07d540a).
 *   A registry entry that fails is reported with `kit.component_invalid` (Clause 01a11bb1-8d03-7751-9173-b3c3f1ab7156).
 * - The best-effort import scan (Rule 01a11bb1-a310-70a6-9f9b-c87ec2bcfaf9), `findings` only: a
 *   linear scan of the static and dynamic imports of each script file of a component flags a kit
 *   file it imports that its closure (its files and its `requires`, transitively) does not
 *   declare, an import of a wrapper entry, and a declared script file after the first (the
 *   component's entry) that no file of the component imports.
 *
 * Containment: `kit/` and `kit/src/` count only as real directories, not symbolic links, under
 * the Workspace root's real path, and every file is judged by its real path. A file outside them
 * is reported exactly as a missing one, so no check, finding or message tells anything about what
 * lies outside the Workspace.
 */
export type KitCheckOutcome = Readonly<{ refusals: readonly Diagnostic[]; findings: readonly Diagnostic[] }>

/** The code of a registry entry that fails validation (Clause 01a11bb1-8d03-7751-9173-b3c3f1ab7156). */
export const KIT_COMPONENT_INVALID = 'kit.component_invalid'

/** The kit project's source directory, under which every registry file lies (Clause 01a11bb1-8a44-…). */
const KIT_SOURCE_DIRECTORY = 'src'
/** File extensions the import scan reads. */
const SCRIPT_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue'] as const
/** The largest file the import scan reads; a larger one is not scanned. */
const MAX_SCANNED_FILE_BYTES = 1024 * 1024
/** The most distinct import specifiers the scan takes from one file. */
const MAX_IMPORTS_PER_FILE = 1000
/** The longest import specifier the scan reads. */
const MAX_SPECIFIER_LENGTH = 1024

/**
 * Where the kit project lies: the Workspace root's real path, and `kit/` and `kit/src/` under it,
 * each present only when it is a real directory, not a symbolic link (as Adapter resolution
 * requires of `kit/`).
 */
export type KitProject = Readonly<{ realRoot: string; directory?: string; sourceDirectory?: string }>

export async function locateKitProject(root: string, codeDirectoryName: string): Promise<KitProject> {
	const realRoot = await realpath(root)
	const directory = join(realRoot, codeDirectoryName)
	if (!await isRealDirectory(directory)) return { realRoot }
	const sourceDirectory = join(directory, KIT_SOURCE_DIRECTORY)
	return { realRoot, directory, ...(await isRealDirectory(sourceDirectory) ? { sourceDirectory } : {}) }
}

async function isRealDirectory(path: string): Promise<boolean> {
	return (await realDirectoryIdentity(path).catch(() => undefined)) !== undefined
}

/** The real path of `path` when it lies strictly inside `base` (a real path), else `undefined`, also when it does not exist. */
export async function containedRealPath(base: string, path: string): Promise<string | undefined> {
	const real = await realpath(path).catch(() => undefined)
	if (real === undefined) return undefined
	const rel = relative(base, real)
	return rel === '' || escapesBase(rel) ? undefined : real
}

function escapesBase(rel: string): boolean {
	return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)
}

/**
 * `message` without host paths: the Workspace root's paths and file URLs become `<workspace>`, and
 * any other absolute path or file URL becomes `<path>`, so a Resource or a refusal never names a
 * host path outside the Workspace.
 */
export function maskHostPaths(message: string, roots: readonly string[]): string {
	let result = message
	for (const root of roots) {
		result = result.split(pathToFileURL(root).href).join('<workspace>')
		result = result.split(root).join('<workspace>')
	}
	return result
		.replace(/file:[^\s'"`<>()]*/gu, '<path>')
		.replace(/(^|[\s'"`(=:,[])(?:\/|[A-Za-z]:\\|\\\\)[^\s'"`<>()\],]*/gu, '$1<path>')
}

export type KitCheckInput = Readonly<{
	/** The Workspace root. */
	root: string
	/** The kit project's name relative to the Workspace root (`kit`). */
	codeDirectoryName: string
	next: ProductKit
	/**
	 * The file a write replaces. Only the members that differ from it are checked, so drift in the
	 * kit project never blocks an unrelated change; without it (a read) everything is checked.
	 */
	current?: ProductKit
}>

export async function checkProductKitAgainstKit(input: KitCheckInput): Promise<KitCheckOutcome> {
	const { codeDirectoryName, next, current } = input
	const kit = await locateKitProject(input.root, codeDirectoryName)
	const changed = (member: keyof ProductKit) => current === undefined || canonicalJsonStringify(current[member]) !== canonicalJsonStringify(next[member])
	const refusals: Diagnostic[] = []
	const findings: Diagnostic[] = []

	let declaredCache: ReadonlySet<string> | undefined
	const declared = async (): Promise<ReadonlySet<string> | undefined> => {
		if (declaredCache) return declaredCache
		// Without a real kit/ directory there is no package file: it declares nothing, as a missing one.
		if (!kit.directory) {
			declaredCache = new Set()
			return declaredCache
		}
		try {
			declaredCache = await readDeclaredKitDependencies(kit.directory)
			return declaredCache
		}
		catch (error) {
			const message = error instanceof Error ? maskHostPaths(error.message, [kit.realRoot]) : `${codeDirectoryName}/package.json could not be read.`
			refusals.push({ code: 'product_kit.kit_package_unreadable', path: '/', message })
			declaredCache = new Set()
			return undefined
		}
	}

	if (changed('adapters')) {
		const kitDependencies = next.adapters.some(entry => !entry.moduleSpecifier.startsWith('./')) ? await declared() : new Set<string>()
		next.adapters.forEach((entry, index) => {
			const problem = specifierProblem(codeDirectoryName, entry.moduleSpecifier, kitDependencies)
			if (problem) refusals.push({ code: 'product_kit.specifier_refused', path: `${jsonPointer('/adapters', index)}/moduleSpecifier`, message: problem })
		})
	}
	if (changed('styles')) {
		const kitDependencies = next.styles.some(style => !style.startsWith('./')) ? await declared() : new Set<string>()
		next.styles.forEach((style, index) => {
			const problem = specifierProblem(codeDirectoryName, style, kitDependencies)
			if (problem) refusals.push({ code: 'product_kit.specifier_refused', path: jsonPointer('/styles', index), message: problem.replace('Adapter module specifier', 'Style specifier') })
		})
	}
	if (changed('designSystems') && next.designSystems.length > 0) {
		const kitDependencies = await declared()
		if (kitDependencies) {
			next.designSystems.forEach((name, index) => {
				if (!kitDependencies.has(name))
					refusals.push({ code: 'product_kit.package_undeclared', path: jsonPointer('/designSystems', index), message: `${name} is not a dependency that ${codeDirectoryName}/package.json declares; a Design System package enters the Product Kit only as a declared dependency.` })
			})
		}
	}
	if (changed('components') || changed('adapters')) {
		const registry = await checkRegistry(kit, codeDirectoryName, next, () => declared())
		// A registry change is refused for its entries; a composition that makes an existing entry
		// name a wrapper entry is reported, not refused, since it changed no entry.
		if (changed('components')) refusals.push(...registry.refusals)
		else findings.push(...registry.refusals)
		findings.push(...registry.findings)
	}
	return { refusals, findings }
}

function specifierProblem(codeDirectoryName: string, specifier: string, declared: ReadonlySet<string> | undefined): string | undefined {
	if (specifier.startsWith('./')) return relativeKitSpecifierProblem(codeDirectoryName, specifier)
	// An unreadable kit/package.json is already refused; a malformed name is still worth naming.
	if (declared === undefined) return bareSpecifierPackageName(specifier) === undefined ? bareKitSpecifierProblem(codeDirectoryName, specifier, new Set()) : undefined
	return bareKitSpecifierProblem(codeDirectoryName, specifier, declared)
}

/**
 * The kit-relative paths of the wrapper entries. Until the kit build lands (K7), a wrapper entry is
 * the module of a `./` Adapter (#139 owner ruling 2026-10-11, 3).
 */
function wrapperEntries(kit: ProductKit): ReadonlySet<string> {
	return new Set(kit.adapters.filter(entry => entry.moduleSpecifier.startsWith('./')).map(entry => posix.normalize(entry.moduleSpecifier.slice(2))))
}

async function checkRegistry(project: KitProject, codeDirectoryName: string, kit: ProductKit, declared: () => Promise<ReadonlySet<string> | undefined>): Promise<KitCheckOutcome> {
	const refusals: Diagnostic[] = []
	const wrappers = wrapperEntries(kit)
	const realFiles = new Map<string, string>()
	const invalid = (path: string, message: string) => refusals.push({ code: KIT_COMPONENT_INVALID, path, message })

	for (const [name, component] of Object.entries(kit.components)) {
		const componentPath = jsonPointer('/components', name)
		for (const [index, file] of component.files.entries()) {
			const filePath = jsonPointer(`${componentPath}/files`, index)
			if (wrappers.has(posix.normalize(file))) {
				invalid(filePath, `${codeDirectoryName}/${file} is a wrapper entry (a ./ Adapter module); a registry component never includes it.`)
				continue
			}
			const real = await sourceFile(project, file)
			if (real === undefined) invalid(filePath, `Component ${name} declares ${codeDirectoryName}/${file}, which is not a regular file under ${codeDirectoryName}/${KIT_SOURCE_DIRECTORY}/ by its real path.`)
			else realFiles.set(posix.normalize(file), real)
		}
		if (component.packages && component.packages.length > 0) {
			const kitDependencies = await declared()
			if (kitDependencies) {
				component.packages.forEach((packageName, index) => {
					if (!kitDependencies.has(packageName))
						invalid(jsonPointer(`${componentPath}/packages`, index), `Component ${name} names ${packageName}, which ${codeDirectoryName}/package.json does not declare.`)
				})
			}
		}
	}
	const findings = refusals.length === 0 && project.directory ? await scanImports(project.directory, realFiles, codeDirectoryName, kit, wrappers) : []
	return { refusals, findings }
}

/**
 * The real path of a declared component file when it is a regular file under the real `kit/src/`,
 * else `undefined`: missing, outside `kit/src/` (through any symbolic link) and not a regular file
 * are one answer, so the check reveals nothing about what lies outside.
 */
async function sourceFile(project: KitProject, file: string): Promise<string | undefined> {
	if (!project.directory || !project.sourceDirectory) return undefined
	const real = await containedRealPath(project.sourceDirectory, join(project.directory, ...file.split('/')))
	if (real === undefined) return undefined
	const info = await lstat(real).catch(() => undefined)
	return info?.isFile() ? real : undefined
}

/** The best-effort import scan (Rule 01a11bb1-a310-70a6-9f9b-c87ec2bcfaf9). */
async function scanImports(kitDirectory: string, realFiles: ReadonlyMap<string, string>, codeDirectoryName: string, kit: ProductKit, wrappers: ReadonlySet<string>): Promise<Diagnostic[]> {
	const findings: Diagnostic[] = []
	const closures = new Map<string, ReadonlySet<string>>()
	const closureOf = (name: string): ReadonlySet<string> => {
		const cached = closures.get(name)
		if (cached) return cached
		const files = new Set<string>()
		const visit = (component: string, seen: Set<string>) => {
			if (seen.has(component)) return
			seen.add(component)
			const entry = kit.components[component]
			if (!entry) return
			for (const file of entry.files) files.add(posix.normalize(file))
			for (const required of entry.requires ?? []) visit(required, seen)
		}
		visit(name, new Set())
		closures.set(name, files)
		return files
	}
	const specifiersOf = new Map<string, Promise<readonly string[]>>()

	for (const [name, component] of Object.entries(kit.components)) {
		const componentPath = jsonPointer('/components', name)
		const closure = closureOf(name)
		const own = component.files.map(file => posix.normalize(file))
		const imported = new Set<string>()
		const reported = new Set<string>()
		for (const file of own) {
			const real = realFiles.get(file)
			if (!isScript(file) || real === undefined) continue
			if (!specifiersOf.has(real)) specifiersOf.set(real, importSpecifiers(real))
			for (const specifier of await specifiersOf.get(real)!) {
				if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue
				const target = await resolveKitImport(kitDirectory, posix.join(posix.dirname(file), specifier))
				if (target === undefined) continue
				imported.add(target)
				if (reported.has(target)) continue
				if (wrappers.has(target)) {
					reported.add(target)
					findings.push({ code: KIT_COMPONENT_INVALID, path: componentPath, message: `Component ${name} imports ${codeDirectoryName}/${target}, a wrapper entry; no file of a registry component imports it.` })
				}
				else if (!closure.has(target)) {
					reported.add(target)
					findings.push({ code: KIT_COMPONENT_INVALID, path: componentPath, message: `Component ${name} imports ${codeDirectoryName}/${target}, which neither it nor a component it requires declares.` })
				}
			}
		}
		// A component's first listed file is its entry (#139 owner ruling 2026-10-11, 3).
		own.forEach((file, index) => {
			if (index === 0 || !isScript(file) || imported.has(file)) return
			findings.push({ code: KIT_COMPONENT_INVALID, path: jsonPointer(`${componentPath}/files`, index), message: `Component ${name} declares ${codeDirectoryName}/${file}, which no file of the component imports.` })
		})
	}
	return findings
}

function isScript(file: string): boolean {
	return SCRIPT_EXTENSIONS.some(extension => file.endsWith(extension))
}

/** The import specifiers of the file at the real path `path`, or none when it is larger than the scan reads. */
async function importSpecifiers(path: string): Promise<readonly string[]> {
	const info = await lstat(path).catch(() => undefined)
	if (!info?.isFile() || info.size > MAX_SCANNED_FILE_BYTES) return []
	const text = await readFile(path, 'utf8').catch(() => '')
	return scanImportSpecifiers(text)
}

const KEYWORD = /\b(?:import|export|require)\b/gu
const TERMINATORS = new Set(['\'', '"', '`', ';'])

function isSpace(char: string | undefined): boolean {
	return char !== undefined && /\s/u.test(char)
}

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && /\w/u.test(char)
}

/**
 * The distinct module specifiers of `text`'s static imports and re-exports (`import … from 'x'`,
 * `export … from 'x'`), side-effect imports (`import 'x'`), dynamic imports (`import('x')`) and
 * `require('x')` calls, at most {@link MAX_IMPORTS_PER_FILE}.
 *
 * A single forward pass: each keyword is looked at once, and the clause of a static import, which
 * reaches the next quote, backtick or semicolon, is judged from that terminator, which is found
 * once for every keyword that shares it. The time is linear in the text's length.
 */
export function scanImportSpecifiers(text: string): string[] {
	const found = new Set<string>()
	const strings = new Map<number, Readonly<{ value: string; end: number }> | undefined>()
	let terminator = -2
	let consumed = 0

	/** The string literal opening at `quote`: its value and the index after it, or `undefined`. */
	const stringAt = (quote: number): Readonly<{ value: string; end: number }> | undefined => {
		if (strings.has(quote)) return strings.get(quote)
		const mark = text[quote]
		let result: Readonly<{ value: string; end: number }> | undefined
		if (mark === '\'' || mark === '"') {
			const limit = Math.min(text.length, quote + 1 + MAX_SPECIFIER_LENGTH + 1)
			for (let index = quote + 1; index < limit; index++) {
				const char = text[index]
				if (char === '\n' || char === '\'' || char === '"') {
					if (char === mark && index > quote + 1) result = { value: text.slice(quote + 1, index), end: index + 1 }
					break
				}
			}
		}
		strings.set(quote, result)
		return result
	}
	const skipSpace = (index: number): number => {
		let at = index
		while (isSpace(text[at])) at++
		return at
	}
	/** The first quote, backtick or semicolon at or after `from`; positions only grow, so each is scanned once. */
	const nextTerminator = (from: number): number => {
		if (terminator >= from || terminator === -1) return terminator
		let index = from
		while (index < text.length && !TERMINATORS.has(text[index]!)) index++
		terminator = index < text.length ? index : -1
		return terminator
	}
	/** Whether `from` ends right before `at` (spaces aside), as a word starting after `after`. */
	const fromEndsAt = new Map<number, number>()
	const fromStartBefore = (at: number): number => {
		const cached = fromEndsAt.get(at)
		if (cached !== undefined) return cached
		let end = at
		while (end > 0 && isSpace(text[end - 1])) end--
		const start = text.slice(Math.max(0, end - 4), end) === 'from' ? end - 4 : -1
		const result = start >= 0 && !isWordChar(text[start - 1]) ? start : -1
		fromEndsAt.set(at, result)
		return result
	}
	const take = (literal: Readonly<{ value: string; end: number }> | undefined, closeParen: boolean): boolean => {
		if (!literal) return false
		let end = literal.end
		if (closeParen) {
			end = skipSpace(end)
			if (text[end] !== ')') return false
			end++
		}
		found.add(literal.value)
		consumed = end
		return true
	}

	for (const match of text.matchAll(KEYWORD)) {
		if (found.size >= MAX_IMPORTS_PER_FILE) break
		const keyword = match[0]
		const start = match.index
		if (start < consumed) continue
		const after = start + keyword.length
		const next = skipSpace(after)
		if (keyword === 'require') {
			if (text[next] === '(') take(stringAt(skipSpace(next + 1)), true)
			continue
		}
		if (keyword === 'import') {
			if (text[next] === '\'' || text[next] === '"') {
				take(stringAt(next), false)
				continue
			}
			if (text[next] === '(') {
				take(stringAt(skipSpace(next + 1)), true)
				continue
			}
		}
		// `import … from 'x'` and `export … from 'x'`: a space, then a clause up to the first quote.
		if (next === after) continue
		const quote = nextTerminator(after + 1)
		if (quote < 0 || (text[quote] !== '\'' && text[quote] !== '"')) continue
		const fromStart = fromStartBefore(quote)
		if (fromStart > after) take(stringAt(quote), false)
	}
	return [...found]
}

/**
 * The kit-relative path of the regular file a relative import names, trying script extensions and
 * `index` files, when its real path lies in the real `kit/`; a file reached through a link out of
 * `kit/` is treated as missing.
 */
async function resolveKitImport(kitDirectory: string, joined: string): Promise<string | undefined> {
	const base = posix.normalize(joined)
	if (base === '..' || base.startsWith('../') || posix.isAbsolute(base)) return undefined
	const stripped = base.replace(/\?.*$/u, '')
	const candidates = [stripped, ...SCRIPT_EXTENSIONS.map(extension => `${stripped}${extension}`), ...SCRIPT_EXTENSIONS.map(extension => `${stripped}/index${extension}`)]
	// A TypeScript import may name the emitted `.js` of a `.ts` source.
	if (/\.[cm]?js$/u.test(stripped)) candidates.push(stripped.replace(/js$/u, 'ts'))
	for (const candidate of candidates) {
		const real = await containedRealPath(kitDirectory, join(kitDirectory, ...candidate.split('/')))
		if (real === undefined) continue
		const info = await lstat(real).catch(() => undefined)
		if (info?.isFile()) return candidate
	}
	return undefined
}
