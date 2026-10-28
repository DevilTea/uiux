import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { createSpecClient } from '@deviltea/spec-tool'

import {
	REQUIREMENT_DIAGNOSTIC_CODES,
	type RequirementsProvider,
	type RequirementsSetting,
	type SpecRequirementsProvider,
} from '../../domain/requirements/schema'
import { isRecord, type Diagnostic } from '../../domain/validation'

/**
 * Reads the requirement provider of the Workspace manifest's `requirements` setting (Clauses
 * 01a18120-f49d-7b42-bad5-69d727f6a33a and 01a18120-f5b9-75e2-83a6-8048dc5d6fba).
 *
 * - No setting: `none`; no ID is checked against any source (Rule 01a18120-fb3a-…).
 * - A `url` provider: links only, no coverage (Rule 01a18120-fc4e-…).
 * - A `spec` provider: the Rules of the Spec Tool workspace at its `path`, read through
 *   `@deviltea/spec-tool` and never written (Rule 01a18120-fcd7-…), each identified by its full UUID. A
 *   provider that cannot be read, or is not a Spec Tool workspace, is `unavailable`
 *   (`requirements.provider_unavailable`).
 */
export type RequirementsProviderRead =
	| Readonly<{ status: 'none' }>
	| Readonly<{ status: 'url'; provider: RequirementsProvider; noUi: Readonly<Record<string, string>> }>
	| Readonly<{ status: 'ok'; provider: RequirementsProvider; noUi: Readonly<Record<string, string>>; rules: ReadonlyMap<string, string> }>
	| Readonly<{ status: 'unavailable'; provider: RequirementsProvider; noUi: Readonly<Record<string, string>>; reason: string }>

/** How long a read of a Spec Tool workspace may take (its reader lock waits on a writer up to 30 s). */
const SPEC_READ_TIMEOUT_MS = 10_000

/** Test seam: the Git work tree root of a directory, or `undefined` outside a Git work tree. */
export type GitWorkTreeRoot = (directory: string) => Promise<string | undefined>

export type RequirementsProviderOptions = Readonly<{ gitWorkTreeRoot?: GitWorkTreeRoot }>

/** The Git work tree root of `directory`, or `undefined` outside a Git work tree or without Git. */
export const gitWorkTreeRoot: GitWorkTreeRoot = directory => new Promise((resolveRoot) => {
	execFile('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8', timeout: 5_000 }, (error, stdout) => {
		const root = error ? '' : String(stdout).trim()
		resolveRoot(root === '' ? undefined : root)
	})
})

function isInside(path: string, directory: string): boolean {
	return path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`)
}

/** The real path of `path`, or of its nearest existing ancestor with the remaining segments appended. */
async function realPathOrAncestor(path: string): Promise<string> {
	let existing = path
	const rest: string[] = []
	for (;;) {
		try {
			const real = await realpath(existing)
			return rest.length === 0 ? real : join(real, ...rest.reverse())
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
			const parent = dirname(existing)
			if (parent === existing) return path
			rest.push(basename(existing))
			existing = parent
		}
	}
}

/**
 * Clause 01a18120-f49d-…: the `spec` provider's directory, from `path` relative to the Workspace
 * root, whose real path lies inside the Git work tree that holds the Workspace root. The result
 * is the directory holding the Spec Tool workspace's `.spec/` (a `path` naming `.spec` itself
 * resolves to its parent), or a refusal.
 */
export async function resolveSpecProviderRoot(
	workspaceRoot: string,
	provider: SpecRequirementsProvider,
	options: RequirementsProviderOptions = {},
): Promise<Readonly<{ ok: true; root: string }> | Readonly<{ ok: false; reason: string }>> {
	const toplevel = await (options.gitWorkTreeRoot ?? gitWorkTreeRoot)(workspaceRoot)
	if (toplevel === undefined) return { ok: false, reason: 'A spec requirements provider needs a Git work tree, and the Workspace root is in none.' }
	let target: string
	let tree: string
	try {
		tree = await realpath(toplevel)
		target = await realPathOrAncestor(resolve(workspaceRoot, ...provider.path.split('/')))
	}
	catch (error) {
		return { ok: false, reason: `The spec provider path cannot be resolved: ${(error as NodeJS.ErrnoException).code ?? 'error'}.` }
	}
	if (!isInside(target, tree)) return { ok: false, reason: 'The real path of a spec provider lies outside the Git work tree that holds the Workspace root.' }
	return { ok: true, root: basename(target) === '.spec' ? dirname(target) : target }
}

/**
 * The Rules of the Spec Tool workspace of a `spec` provider, by full UUID (the statement is the
 * Rule's text), or the reason it cannot be read.
 */
export async function readSpecProviderRules(
	workspaceRoot: string,
	provider: SpecRequirementsProvider,
	options: RequirementsProviderOptions = {},
): Promise<Readonly<{ ok: true; rules: ReadonlyMap<string, string> }> | Readonly<{ ok: false; reason: string }>> {
	const resolved = await resolveSpecProviderRoot(workspaceRoot, provider, options)
	if (!resolved.ok) return resolved
	try {
		if (!(await lstat(join(resolved.root, '.spec'))).isDirectory()) return { ok: false, reason: 'The provider path holds no Spec Tool workspace.' }
	}
	catch {
		return { ok: false, reason: 'The provider path holds no Spec Tool workspace.' }
	}
	let timer: NodeJS.Timeout | undefined
	try {
		const exported = await Promise.race([
			createSpecClient(resolved.root).graph.export(),
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The Spec Tool workspace did not answer in time.')), SPEC_READ_TIMEOUT_MS) }),
		])
		const rules = new Map<string, string>()
		for (const node of exported.data.nodes) {
			if (node.kind === 'rule') rules.set(node.id, node.statement)
		}
		return { ok: true, rules }
	}
	catch (error) {
		return { ok: false, reason: error instanceof Error && error.message !== '' ? error.message : 'The Spec Tool workspace cannot be read.' }
	}
	finally {
		if (timer) clearTimeout(timer)
	}
}

/** Reads the provider of `setting` (the manifest's `requirements`, possibly absent). */
export async function readRequirementsProvider(
	workspaceRoot: string,
	setting: RequirementsSetting | undefined,
	options: RequirementsProviderOptions = {},
): Promise<RequirementsProviderRead> {
	if (!setting) return { status: 'none' }
	const { noUi: rawNoUi, ...provider } = setting
	// A manifest edited by hand may hold anything here; the validator reports it, the read ignores it.
	const noUi: Readonly<Record<string, string>> = isRecord(rawNoUi) ? rawNoUi as Record<string, string> : {}
	if (provider.provider === 'url') return { status: 'url', provider, noUi }
	const read = await readSpecProviderRules(workspaceRoot, provider, options)
	return read.ok ? { status: 'ok', provider, noUi, rules: read.rules } : { status: 'unavailable', provider, noUi, reason: read.reason }
}

/**
 * Clause 01a18120-f5b9-…: the diagnostics of `ids` read against `read`, at `path` + `/<index>`: an
 * ID a read `spec` provider lacks is `requirements.unresolved`; an unavailable provider is one
 * `requirements.provider_unavailable` at `path` and then no ID is unresolved; no other provider
 * checks an ID.
 */
export function requirementDiagnostics(read: RequirementsProviderRead, ids: readonly string[], path: string): readonly Diagnostic[] {
	if (read.status === 'unavailable')
		return ids.length === 0 ? [] : [providerUnavailableDiagnostic(read, path)]
	if (read.status !== 'ok') return []
	const out: Diagnostic[] = []
	ids.forEach((id, index) => {
		if (!read.rules.has(id))
			out.push({ code: REQUIREMENT_DIAGNOSTIC_CODES.unresolved, path: `${path}/${index}`, message: `The requirement ${id} is not a Rule of the spec provider.` })
	})
	return out
}

/**
 * {@link requirementDiagnostics} over several lists of one resource, `[ids, path]` each: an
 * unavailable provider is one diagnostic, at the path of the first list that names an ID.
 */
export function requirementListDiagnostics(read: RequirementsProviderRead, lists: readonly (readonly [readonly string[], string])[]): readonly Diagnostic[] {
	if (read.status === 'unavailable') {
		const first = lists.find(([ids]) => ids.length > 0)
		return first ? [providerUnavailableDiagnostic(read, first[1])] : []
	}
	return lists.flatMap(([ids, path]) => requirementDiagnostics(read, ids, path))
}

export function providerUnavailableDiagnostic(read: Extract<RequirementsProviderRead, { status: 'unavailable' }>, path: string): Diagnostic {
	return { code: REQUIREMENT_DIAGNOSTIC_CODES.providerUnavailable, path, message: `The spec requirements provider cannot be read: ${read.reason}` }
}

/** The `noUi` IDs a read `spec` provider lacks, as `requirements.unresolved` at `/requirements/noUi/<id>`. */
export function noUiDiagnostics(read: RequirementsProviderRead, path = '/requirements/noUi'): readonly Diagnostic[] {
	if (read.status === 'unavailable')
		return Object.keys(read.noUi).length === 0 ? [] : [providerUnavailableDiagnostic(read, path)]
	if (read.status !== 'ok') return []
	return Object.keys(read.noUi)
		.filter(id => !read.rules.has(id))
		.map(id => ({ code: REQUIREMENT_DIAGNOSTIC_CODES.unresolved, path: `${path}/${id.replaceAll('~', '~0').replaceAll('/', '~1')}`, message: `The noUi requirement ${id} is not a Rule of the spec provider.` }))
}
