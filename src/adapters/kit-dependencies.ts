import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

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
	try {
		const info = await lstat(path)
		if (!info.isFile())
			throw new Error(`kit/${KIT_PACKAGE_FILENAME} is not a regular file.`)
	}
	catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code
		if (code === 'ENOENT' || code === 'ENOTDIR') return new Set()
		throw error
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(await readFile(path, 'utf8'))
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
