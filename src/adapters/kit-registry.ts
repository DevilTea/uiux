import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, posix, relative, sep } from 'node:path'

import { canonicalJsonStringify } from '../domain/canonical-json'
import type { ProductKit } from '../domain/product-kit/schema'
import { jsonPointer, type Diagnostic } from '../domain/validation'
import { bareKitSpecifierProblem, bareSpecifierPackageName, readDeclaredKitDependencies, relativeKitSpecifierProblem } from './kit-dependencies'

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
 *   that is the module of a `./` Adapter (Clause 01a11bb1-89e2-75f8-8131-97b0a07d540a). A registry
 *   entry that fails is reported with `kit.component_invalid` (Clause 01a11bb1-8d03-7751-9173-b3c3f1ab7156).
 * - The best-effort import scan (Rule 01a11bb1-a310-70a6-9f9b-c87ec2bcfaf9), `findings` only: a
 *   regular-expression scan of the static and dynamic imports of each script file of a component
 *   flags a kit file it imports that its closure (its files and its `requires`, transitively) does
 *   not declare, an import of a wrapper entry, and a declared script file after the first (the
 *   component's entry) that no file of the component imports.
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
const IMPORT_PATTERN = /\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1|\bimport\s*(['"])([^'"\n]+)\3|\bimport\s*\(\s*(['"])([^'"\n]+)\5\s*\)|\brequire\s*\(\s*(['"])([^'"\n]+)\7\s*\)/gu

export type KitCheckInput = Readonly<{
	/** The kit project's absolute path. */
	kitDirectory: string
	/** Its name relative to the Workspace root (`kit`), for messages. */
	codeDirectoryName: string
	next: ProductKit
	/**
	 * The file a write replaces. Only the members that differ from it are checked, so drift in the
	 * kit project never blocks an unrelated change; without it (a read) everything is checked.
	 */
	current?: ProductKit
}>

export async function checkProductKitAgainstKit(input: KitCheckInput): Promise<KitCheckOutcome> {
	const { kitDirectory, codeDirectoryName, next, current } = input
	const changed = (member: keyof ProductKit) => current === undefined || canonicalJsonStringify(current[member]) !== canonicalJsonStringify(next[member])
	const refusals: Diagnostic[] = []
	const findings: Diagnostic[] = []

	let declaredCache: ReadonlySet<string> | undefined
	const declared = async (): Promise<ReadonlySet<string> | undefined> => {
		if (declaredCache) return declaredCache
		try {
			declaredCache = await readDeclaredKitDependencies(kitDirectory)
			return declaredCache
		}
		catch (error) {
			refusals.push({ code: 'product_kit.kit_package_unreadable', path: '/', message: error instanceof Error ? error.message : `${codeDirectoryName}/package.json could not be read.` })
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
		const registry = await checkRegistry(kitDirectory, codeDirectoryName, next, () => declared())
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

/** The kit-relative paths of the wrapper entries: the modules of the `./` Adapters. */
function wrapperEntries(kit: ProductKit): ReadonlySet<string> {
	return new Set(kit.adapters.filter(entry => entry.moduleSpecifier.startsWith('./')).map(entry => posix.normalize(entry.moduleSpecifier.slice(2))))
}

async function checkRegistry(kitDirectory: string, codeDirectoryName: string, kit: ProductKit, declared: () => Promise<ReadonlySet<string> | undefined>): Promise<KitCheckOutcome> {
	const refusals: Diagnostic[] = []
	const findings: Diagnostic[] = []
	const wrappers = wrapperEntries(kit)
	const sourceDirectory = join(kitDirectory, KIT_SOURCE_DIRECTORY)
	const realSource = await realpath(sourceDirectory).catch(() => undefined)
	const invalid = (path: string, message: string) => refusals.push({ code: KIT_COMPONENT_INVALID, path, message })

	for (const [name, component] of Object.entries(kit.components)) {
		const componentPath = jsonPointer('/components', name)
		for (const [index, file] of component.files.entries()) {
			const filePath = jsonPointer(`${componentPath}/files`, index)
			if (wrappers.has(posix.normalize(file))) {
				invalid(filePath, `${codeDirectoryName}/${file} is a wrapper entry (a ./ Adapter module); a registry component never includes it.`)
				continue
			}
			const problem = await sourceFileProblem(kitDirectory, realSource, file)
			if (problem) invalid(filePath, `Component ${name} declares ${codeDirectoryName}/${file}, which ${problem}.`)
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
	if (refusals.length === 0) findings.push(...await scanImports(kitDirectory, codeDirectoryName, kit, wrappers))
	return { refusals, findings }
}

/** Why a declared component file is not a regular file under `kit/src/` by its real path, or `undefined`. */
async function sourceFileProblem(kitDirectory: string, realSource: string | undefined, file: string): Promise<string | undefined> {
	if (!realSource) return `does not exist: ${KIT_SOURCE_DIRECTORY}/ is not a directory in the kit project`
	const absolute = join(kitDirectory, ...file.split('/'))
	const info = await lstat(absolute).catch(() => undefined)
	if (!info) return 'does not exist'
	let real: string
	try {
		real = await realpath(absolute)
	}
	catch {
		return 'does not exist'
	}
	const rel = relative(realSource, real)
	if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../'))
		return `lies outside ${KIT_SOURCE_DIRECTORY}/ by its real path`
	const target = info.isSymbolicLink() ? await lstat(real).catch(() => undefined) : info
	if (!target?.isFile()) return 'is not a regular file'
	return undefined
}

/** The best-effort import scan (Rule 01a11bb1-a310-70a6-9f9b-c87ec2bcfaf9). */
async function scanImports(kitDirectory: string, codeDirectoryName: string, kit: ProductKit, wrappers: ReadonlySet<string>): Promise<Diagnostic[]> {
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

	for (const [name, component] of Object.entries(kit.components)) {
		const componentPath = jsonPointer('/components', name)
		const closure = closureOf(name)
		const own = component.files.map(file => posix.normalize(file))
		const imported = new Set<string>()
		const reported = new Set<string>()
		for (const file of own) {
			if (!isScript(file)) continue
			for (const specifier of await importSpecifiers(join(kitDirectory, ...file.split('/')))) {
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

async function importSpecifiers(path: string): Promise<readonly string[]> {
	const info = await lstat(path).catch(() => undefined)
	if (!info?.isFile() || info.size > MAX_SCANNED_FILE_BYTES) return []
	const text = await readFile(path, 'utf8').catch(() => '')
	const specifiers: string[] = []
	for (const match of text.matchAll(IMPORT_PATTERN)) {
		const specifier = match[2] ?? match[4] ?? match[6] ?? match[8]
		if (specifier) specifiers.push(specifier)
	}
	return specifiers
}

/** The kit-relative path of the regular file a relative import names, trying script extensions and `index` files. */
async function resolveKitImport(kitDirectory: string, joined: string): Promise<string | undefined> {
	const base = posix.normalize(joined)
	if (base === '..' || base.startsWith('../') || posix.isAbsolute(base)) return undefined
	const stripped = base.replace(/\?.*$/u, '')
	const candidates = [stripped, ...SCRIPT_EXTENSIONS.map(extension => `${stripped}${extension}`), ...SCRIPT_EXTENSIONS.map(extension => `${stripped}/index${extension}`)]
	// A TypeScript import may name the emitted `.js` of a `.ts` source.
	if (/\.[cm]?js$/u.test(stripped)) candidates.push(stripped.replace(/js$/u, 'ts'))
	for (const candidate of candidates) {
		const info = await lstat(join(kitDirectory, ...candidate.split('/'))).catch(() => undefined)
		if (info?.isFile()) return candidate
	}
	return undefined
}
