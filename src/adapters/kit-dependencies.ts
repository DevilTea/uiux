import { lstat, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { isProductKitPackageName } from '../domain/product-kit/schema'
import { isSafeRelativePath } from '../domain/validation'

/** The kit project's package file, which only the host edits (Discussion #139 decision 5, Trust). */
export const KIT_PACKAGE_FILENAME = 'package.json'

/** The directory a package manager installs packages into, inside the kit project or any package. */
const DEPENDENCY_DIRECTORY = 'node_modules'

/**
 * The `kit/package.json` members whose keys are the kit project's declared dependencies (Clause
 * 01a115cd-d109-76d3-9622-85d0080c60b6, the dependency guard): all four npm dependency members,
 * per the Discussion #139 owner ruling of 2026-10-11
 * (https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18858542).
 */
export const KIT_DEPENDENCY_MEMBERS = Object.freeze(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const)

/**
 * The package a bare specifier names (`name` or `@scope/name`, followed by an optional subpath),
 * or `undefined` when the specifier names no npm package: a `#` import, a malformed name, or a
 * subpath with an empty, `.`, `..` or `node_modules` segment (in any case) or a percent escape.
 * Such a subpath would let a declared package's name lead, through Node's resolution of a package
 * without `exports` (which joins the subpath to the package directory as a URL, where `%2e%2e` is
 * `..`), into a package that `kit/package.json` does not declare.
 */
export function bareSpecifierPackageName(specifier: string): string | undefined {
	const segments = specifier.split('/')
	const nameSegments = specifier.startsWith('@') ? 2 : 1
	if (segments.length < nameSegments) return undefined
	const name = segments.slice(0, nameSegments).join('/')
	if (!isProductKitPackageName(name)) return undefined
	if (segments.length > nameSegments) {
		const subpath = segments.slice(nameSegments).join('/')
		if (!isSafeRelativePath(subpath) || subpath.includes('%')) return undefined
		if (subpath.split('/').some(segment => segment.toLowerCase() === DEPENDENCY_DIRECTORY)) return undefined
	}
	return name
}

/**
 * The dependency names that `<codeDirectory>/package.json` declares. A kit without the file declares
 * none (the minimal form of plain-module Adapters needs no package file). The file must be a
 * regular file, not a link to one elsewhere, and well formed; anything else fails closed by
 * throwing, so a bare specifier is never resolved on a guess.
 */
export async function readDeclaredKitDependencies(codeDirectory: string): Promise<ReadonlySet<string>> {
	const path = join(codeDirectory, KIT_PACKAGE_FILENAME)
	let info: Awaited<ReturnType<typeof lstat>>
	try {
		info = await lstat(path)
	}
	catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code
		if (code === 'ENOENT' || code === 'ENOTDIR') return new Set()
		throw unreadable(error)
	}
	if (!info.isFile())
		throw new Error(`kit/${KIT_PACKAGE_FILENAME} is not a regular file.`)
	let text: string
	try {
		text = await readFile(path, 'utf8')
	}
	catch (error) {
		throw unreadable(error)
	}
	return declaredKitDependencies(text)
}

/**
 * The dependency names a kit `package.json` with the text `text` declares in any of
 * {@link KIT_DEPENDENCY_MEMBERS}; `undefined` (no file) declares none. Text that is not a JSON
 * object, or a member that is not an object, throws, so a caller fails closed. Reading the file is
 * the caller's: it must refuse a symbolic link, as {@link readDeclaredKitDependencies} does.
 */
export function declaredKitDependencies(text: string | undefined): ReadonlySet<string> {
	if (text === undefined) return new Set()
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	}
	catch (error) {
		throw new Error(`kit/${KIT_PACKAGE_FILENAME} could not be read as JSON.`, { cause: error })
	}
	if (!isPlainObject(parsed))
		throw new Error(`kit/${KIT_PACKAGE_FILENAME} is not a JSON object.`)
	const declared = new Set<string>()
	for (const member of KIT_DEPENDENCY_MEMBERS) {
		const value = parsed[member]
		if (value === undefined) continue
		if (!isPlainObject(value))
			throw new Error(`kit/${KIT_PACKAGE_FILENAME} member ${member} is not an object.`)
		for (const name of Object.keys(value)) declared.add(name)
	}
	return declared
}

/**
 * A read failure (EACCES, EISDIR, EIO, ...) as a message without the host's absolute path, which
 * would otherwise reach Workbench and MCP diagnostics; the original error stays as the cause.
 */
function unreadable(cause: unknown): Error {
	return new Error(`kit/${KIT_PACKAGE_FILENAME} could not be read.`, { cause })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The as-written rule for a `./` specifier resolved from the kit project (Clause
 * 01a115cd-d109-76d3-9622-85d0080c60b6, from `schemaVersion` 5): it names a path inside
 * `<codeDirectoryName>/` and outside its `node_modules/`. Returns the problem, or `undefined`.
 * Shared by Adapter resolution and the Product Kit authoring operations, which apply it before
 * storing a specifier; resolution also checks the real path the specifier resolves to.
 */
export function relativeKitSpecifierProblem(codeDirectoryName: string, moduleSpecifier: string): string | undefined {
	const authored = posix.normalize(moduleSpecifier.slice(2))
	if (authored === '.' || authored === './' || authored === '..' || authored.startsWith('../') || posix.isAbsolute(authored))
		return `Adapter module specifier ${moduleSpecifier} escapes ${codeDirectoryName}/.`
	if ((authored.split('/')[0] ?? '').toLowerCase() === DEPENDENCY_DIRECTORY)
		return `Adapter module specifier ${moduleSpecifier} names a file in ${codeDirectoryName}/${DEPENDENCY_DIRECTORY}/; select a dependency by its bare package name.`
	return undefined
}

/**
 * The dependency guard for a bare specifier resolved from the kit project (Clause
 * 01a115cd-d109-76d3-9622-85d0080c60b6): it names an npm package, followed by a plain subpath,
 * that `<codeDirectoryName>/package.json` declares (`declared`). Returns the problem, or `undefined`.
 */
export function bareKitSpecifierProblem(codeDirectoryName: string, moduleSpecifier: string, declared: ReadonlySet<string>): string | undefined {
	const packageName = bareSpecifierPackageName(moduleSpecifier)
	if (packageName === undefined)
		return `Adapter module specifier ${moduleSpecifier} does not name an npm package followed by a plain subpath.`
	if (!declared.has(packageName))
		return `Adapter module specifier ${moduleSpecifier} names ${packageName}, which ${codeDirectoryName}/${KIT_PACKAGE_FILENAME} does not declare as a dependency.`
	return undefined
}
