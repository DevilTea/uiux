import { createHash } from 'node:crypto'

import { diffResource, isDiffableResourceKind, type ResourceDiff, type ResourceFile, type ResourceFiles } from '../../domain/diff'
import { resourceIdentityKey } from '../../domain/resource-identity'
import { isFullUuid } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence/file-native'
import { runGit, type GitFailure } from '../../persistence/git'
import { assetDirectoryRelativePath, assetMetadataRelativePath, flowRelativePath, localeRelativePath, viewRelativePath, type VersionedResourceIdentity } from '../../persistence/paths'

/**
 * The Workbench's read-only view of the changes since a Git base (Feature
 * 01a1ece7-8d4e-763c-8897-2c35ef129a4d, Discussion #491 P1). It lists the canonical resources that
 * are added, changed or removed between a Git base and the working tree, and gives the semantic
 * difference of one. It reads the base content through the `git` CLI and stores nothing: no file, no
 * artifact, no cache. Every `git` call is read-only, a fixed argument list run with `-C <root>`
 * (`src/persistence/git.ts`), and every path it passes is built from a validated resource identity
 * or taken from the layout's own classification of what Git printed.
 */

export const CHANGE_BASES = ['head', 'merge-base'] as const
/** `head`: the commit `HEAD` names. `merge-base`: the merge base of `HEAD` and the repository's default branch. */
export type ChangeBase = typeof CHANGE_BASES[number]

export type ChangeStatus = 'added' | 'modified' | 'removed'

export type ChangedResource = Readonly<{ kind: string; key: string; status: ChangeStatus }>

/** What the base is: which one, and the short commit it names. */
export type ChangeBaseInfo = Readonly<{ base: ChangeBase; commit: string }>

/** Where the toggle stands: whether a default branch could be determined, and its name. */
export type MergeBaseState = Readonly<{ available: boolean; defaultBranch?: string }>

export type ListChangesOutcome =
	| Readonly<{ status: 'listed'; base: ChangeBaseInfo; mergeBase: MergeBaseState; changes: readonly ChangedResource[] }>
	/** Rule 01a1ece7-92cf-79d6-b7d0-1d907da0045b: `git` cannot supply the base; nothing is listed. */
	| Readonly<{ status: 'unavailable'; code: GitChangesFailureCode; message: string; mergeBase: MergeBaseState }>

export type GitChangesFailureCode = 'git.unavailable' | 'git.no_commit' | 'git.no_merge_base' | 'git.too_many_changes'

export type ChangeDiffOutcome =
	| Readonly<{ status: 'compared'; base: ChangeBaseInfo; kind: string; key: string; changeStatus: ChangeStatus; diff: ResourceDiff }>
	| Readonly<{ status: 'invalid' | 'not_found'; code: string; message: string }>
	| Readonly<{ status: 'unavailable'; code: GitChangesFailureCode; message: string }>

export type ChangeBlobOutcome =
	| Readonly<{ status: 'found'; digest: string; bytes: Uint8Array }>
	| Readonly<{ status: 'invalid' | 'not_found'; code: string; message: string }>
	| Readonly<{ status: 'unavailable'; code: GitChangesFailureCode; message: string }>

export type GitChangesService = Readonly<{
	listChanges(query: Readonly<{ base?: ChangeBase }>): Promise<ListChangesOutcome>
	readChangeDiff(query: Readonly<{ base?: ChangeBase; kind: string; key: string }>): Promise<ChangeDiffOutcome>
	readChangeBlob(query: Readonly<{ base?: ChangeBase; key: string; digest: string }>): Promise<ChangeBlobOutcome>
}>

/** More changed resources than this are reported as unavailable rather than read one by one. */
const MAX_CHANGED_RESOURCES = 5_000

type ResolvedBase =
	| Readonly<{ ok: true; info: ChangeBaseInfo; commit: string; prefix: string; mergeBase: MergeBaseState }>
	| Readonly<{ ok: false; code: GitChangesFailureCode; message: string; mergeBase: MergeBaseState }>

const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u

export function createGitChangesService(persistence: FileNativePersistence): GitChangesService {
	const root = persistence.root
	const layout = persistence.layout

	/** The pathspecs of the versioned files and directories, each taken literally. */
	const plainRoots = layout.versionedRoots.map(entry => entry.replace(/\/$/u, ''))
	const pathspecs = plainRoots.map(entry => `:(literal)${entry}`)

	async function git(args: readonly string[], input?: string) {
		return runGit(root, args, input === undefined ? {} : { input })
	}

	function unavailable(failure: GitFailure): Readonly<{ code: GitChangesFailureCode; message: string }> {
		return { code: 'git.unavailable', message: failure.message }
	}

	/** The default branch: `origin/HEAD`, else `init.defaultBranch`, `main` or `master` as a local or a remote branch that exists. */
	async function defaultBranch(): Promise<Readonly<{ name: string; ref: string }> | undefined> {
		const exists = async (ref: string): Promise<boolean> => (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok
		const origin = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
		if (origin.ok) {
			const ref = origin.stdout.toString('utf8').trim()
			const name = ref.startsWith('refs/remotes/origin/') ? ref.slice('refs/remotes/origin/'.length) : ''
			if (name && BRANCH_NAME.test(name) && await exists(ref)) return { name, ref }
		}
		const configured = await git(['config', '--get', 'init.defaultBranch'])
		const candidates = [...(configured.ok ? [configured.stdout.toString('utf8').trim()] : []), 'main', 'master']
		for (const name of candidates) {
			if (!BRANCH_NAME.test(name) || name.includes('..')) continue
			for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) if (await exists(ref)) return { name, ref }
		}
		return undefined
	}

	async function resolveBase(base: ChangeBase): Promise<ResolvedBase> {
		const branch = await defaultBranch()
		const mergeBase: MergeBaseState = branch ? { available: true, defaultBranch: branch.name } : { available: false }
		const head = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
		if (!head.ok) {
			// An unborn branch has no commit; any other failure is Git itself failing.
			const unborn = await git(['rev-parse', '--is-inside-work-tree'])
			return unborn.ok && head.reason === 'failed'
				? { ok: false, code: 'git.no_commit', message: 'This repository has no commit yet, so Git has no base to compare with.', mergeBase }
				: { ok: false, code: 'git.unavailable', message: head.message, mergeBase }
		}
		let commit = head.stdout.toString('utf8').trim()
		let effective: ChangeBase = 'head'
		if (base === 'merge-base' && branch) {
			const found = await git(['merge-base', 'HEAD', branch.ref])
			if (!found.ok) return { ok: false, code: 'git.no_merge_base', message: `Git found no merge base of HEAD and ${branch.name}.`, mergeBase }
			commit = found.stdout.toString('utf8').trim()
			effective = 'merge-base'
		}
		const prefix = await git(['rev-parse', '--show-prefix'])
		if (!prefix.ok) return { ok: false, ...unavailable(prefix), mergeBase }
		// `git rev-parse --show-prefix` ends in a newline; a directory name holding one would break the line-based `cat-file` requests.
		const root = prefix.stdout.toString('utf8').replace(/\n$/u, '')
		if (root.includes('\n')) return { ok: false, code: 'git.unavailable', message: 'The Workspace sits in a directory whose name holds a line break, which this view cannot read through git.', mergeBase }
		return { ok: true, info: { base: effective, commit: commit.slice(0, 12) }, commit, prefix: root, mergeBase }
	}

	/** The resource a path of the Workspace belongs to, or `undefined` for a path the layout does not version. */
	function classify(path: string): VersionedResourceIdentity | undefined {
		return layout.classifyVersionedPath(path)
	}

	/** Every versioned file Git has at `commit`, grouped by resource. */
	async function baseFiles(commit: string, extra: readonly string[] = []): Promise<Map<string, { resource: VersionedResourceIdentity; paths: string[] }> | GitFailure> {
		const listed = await git(['ls-tree', '-r', '-z', '--name-only', commit, '--', ...(extra.length > 0 ? extra : plainRoots)])
		if (!listed.ok) return listed
		const groups = new Map<string, { resource: VersionedResourceIdentity; paths: string[] }>()
		for (const path of listed.stdout.toString('utf8').split('\0').filter(Boolean)) {
			const resource = classify(path)
			if (!resource) continue
			const identity = resourceIdentityKey(resource)
			const group = groups.get(identity) ?? { resource, paths: [] }
			group.paths.push(path)
			groups.set(identity, group)
		}
		return groups
	}

	/** Reads blobs at `commit` through one `cat-file --batch`; a path Git does not have is `undefined`. */
	async function readBlobs(commit: string, prefix: string, paths: readonly string[]): Promise<Map<string, Uint8Array | undefined> | GitFailure> {
		const out = new Map<string, Uint8Array | undefined>()
		if (paths.length === 0) return out
		const result = await git(['cat-file', '--batch'], `${paths.map(path => `${commit}:${prefix}${path}`).join('\n')}\n`)
		if (!result.ok) return result
		const data = result.stdout
		let offset = 0
		for (const path of paths) {
			const end = data.indexOf(0x0A, offset)
			if (end < 0) break
			const header = data.subarray(offset, end).toString('utf8')
			offset = end + 1
			const match = /^[0-9a-f]+ blob (\d+)$/u.exec(header)
			if (!match) {
				out.set(path, undefined)
				continue
			}
			const size = Number(match[1])
			out.set(path, Uint8Array.from(data.subarray(offset, offset + size)))
			offset += size + 1
		}
		return out
	}

	/** The paths that differ between `commit` and the working tree, and the files Git does not track yet. */
	async function changedPaths(commit: string): Promise<string[] | GitFailure> {
		const diff = await git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', '--relative', commit, '--', ...pathspecs])
		if (!diff.ok) return diff
		const untracked = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs])
		if (!untracked.ok) return untracked
		const paths = new Set<string>()
		for (const output of [diff.stdout, untracked.stdout])
			for (const path of output.toString('utf8').split('\0').filter(Boolean)) paths.add(path)
		return [...paths]
	}

	/** The files of one resource in the working tree, under one read lock. */
	function currentFiles(resource: VersionedResourceIdentity): Promise<Map<string, Uint8Array>> {
		return persistence.withReadLock(async () => {
			const files = new Map<string, Uint8Array>()
			if (resource.kind !== 'asset') {
				const path = resourcePath(resource)
				const bytes = path ? await persistence.readOptionalBytesUnlocked(path) : undefined
				if (path && bytes) files.set(path, Uint8Array.from(bytes))
				return files
			}
			const directory = assetDirectoryRelativePath(resource.key)
			for (const entry of await persistence.listDirectoryUnlocked(directory) ?? []) {
				const path = `${directory}/${entry.name}`
				if (!entry.isFile() || !classify(path)) continue
				files.set(path, Uint8Array.from(await persistence.readBytesUnlocked(path)))
			}
			return files
		})
	}

	/** Whether the files hold a resource: a single-file kind has its file, an Asset its `asset.json`. */
	function holdsResource(kind: string, paths: Iterable<string>): boolean {
		const list = [...paths]
		return kind === 'asset' ? list.some(path => path.endsWith('/asset.json')) : list.length > 0
	}

	async function currentPaths(resource: VersionedResourceIdentity): Promise<string[]> {
		return [...(await currentFiles(resource)).keys()]
	}

	async function listChanges(query: Readonly<{ base?: ChangeBase }>): Promise<ListChangesOutcome> {
		const resolved = await resolveBase(query.base ?? 'head')
		if (!resolved.ok) return { status: 'unavailable', code: resolved.code, message: resolved.message, mergeBase: resolved.mergeBase }
		const failed = (failure: GitFailure): ListChangesOutcome => ({ status: 'unavailable', ...unavailable(failure), mergeBase: resolved.mergeBase })
		const paths = await changedPaths(resolved.commit)
		if (!Array.isArray(paths)) return failed(paths as GitFailure)
		const base = await baseFiles(resolved.commit)
		if (!(base instanceof Map)) return failed(base)
		const candidates = new Map<string, VersionedResourceIdentity>()
		for (const path of paths) {
			const resource = classify(path)
			if (resource) candidates.set(resourceIdentityKey(resource), resource)
		}
		if (candidates.size > MAX_CHANGED_RESOURCES)
			return { status: 'unavailable', code: 'git.too_many_changes', message: `More than ${MAX_CHANGED_RESOURCES} resources changed.`, mergeBase: resolved.mergeBase }
		const changes: ChangedResource[] = []
		for (const [identity, resource] of candidates) {
			const before = holdsResource(resource.kind, base.get(identity)?.paths ?? [])
			const after = holdsResource(resource.kind, await currentPaths(resource))
			if (before || after) changes.push({ kind: resource.kind, key: resource.key, status: !before ? 'added' : !after ? 'removed' : 'modified' })
		}
		changes.sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
		return { status: 'listed', base: resolved.info, mergeBase: resolved.mergeBase, changes }
	}

	/** The Workspace-relative path of a single-file resource, or `undefined` for an Asset or an invalid key. */
	function resourcePath(resource: VersionedResourceIdentity): string | undefined {
		try {
			switch (resource.kind) {
				case 'workspace': return layout.manifestPath
				case 'product-kit': return layout.productKitPath
				case 'access-presets': return layout.accessPresetsPath
				case 'view': return viewRelativePath(resource.key)
				case 'flow': return flowRelativePath(resource.key)
				case 'locale': return localeRelativePath(resource.key)
				case 'asset': return assetMetadataRelativePath(resource.key)
				default: return undefined
			}
		}
		catch {
			return undefined
		}
	}

	/** A resource the request names, only when its identity is valid for its kind. */
	function validResource(kind: string, key: string): VersionedResourceIdentity | undefined {
		if (!isDiffableResourceKind(kind)) return undefined
		const resource = { kind, key }
		const path = resourcePath(resource)
		const canonical = path ? classify(path) : undefined
		return canonical && canonical.kind === kind && canonical.key === key ? canonical : undefined
	}

	const digestOf = (bytes: Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

	function asResourceFiles(files: ReadonlyMap<string, Uint8Array>): ResourceFiles | undefined {
		if (files.size === 0) return undefined
		return new Map<string, ResourceFile>([...files].map(([path, bytes]) => [path, { digest: digestOf(bytes), bytes }]))
	}

	async function readChangeDiff(query: Readonly<{ base?: ChangeBase; kind: string; key: string }>): Promise<ChangeDiffOutcome> {
		const resource = validResource(query.kind, query.key)
		if (!resource) return { status: 'invalid', code: 'changes.invalid_resource', message: 'The resource is not a canonical resource of the Workspace.' }
		const resolved = await resolveBase(query.base ?? 'head')
		if (!resolved.ok) return { status: 'unavailable', code: resolved.code, message: resolved.message }
		const group = await baseFiles(resolved.commit, [resource.kind === 'asset' ? assetDirectoryRelativePath(resource.key) : resourcePath(resource)!])
		if (!(group instanceof Map)) return { status: 'unavailable', ...unavailable(group) }
		const basePaths = group.get(resourceIdentityKey(resource))?.paths ?? []
		const read = await readBlobs(resolved.commit, resolved.prefix, basePaths)
		if (!(read instanceof Map)) return { status: 'unavailable', ...unavailable(read) }
		const before = new Map([...read].flatMap(([path, bytes]) => bytes ? [[path, bytes] as const] : []))
		const after = await currentFiles(resource)
		const beforeHeld = holdsResource(resource.kind, before.keys())
		const afterHeld = holdsResource(resource.kind, after.keys())
		if (!beforeHeld && !afterHeld) return { status: 'not_found', code: 'changes.resource_not_found', message: 'The resource exists neither at the base nor in the working tree.' }
		const diff = diffResource(resource.kind, beforeHeld ? asResourceFiles(before) : undefined, afterHeld ? asResourceFiles(after) : undefined)
		return {
			status: 'compared',
			base: resolved.info,
			kind: resource.kind,
			key: resource.key,
			changeStatus: !beforeHeld ? 'added' : !afterHeld ? 'removed' : 'modified',
			diff,
		}
	}

	async function readChangeBlob(query: Readonly<{ base?: ChangeBase; key: string; digest: string }>): Promise<ChangeBlobOutcome> {
		if (!isFullUuid(query.key) || !/^sha256:[0-9a-f]{64}$/u.test(query.digest))
			return { status: 'invalid', code: 'changes.invalid_blob', message: 'An Asset ID and a sha256: digest are required.' }
		const resolved = await resolveBase(query.base ?? 'head')
		if (!resolved.ok) return { status: 'unavailable', code: resolved.code, message: resolved.message }
		const group = await baseFiles(resolved.commit, [assetDirectoryRelativePath(query.key)])
		if (!(group instanceof Map)) return { status: 'unavailable', ...unavailable(group) }
		const paths = group.get(resourceIdentityKey({ kind: 'asset', key: query.key }))?.paths ?? []
		const read = await readBlobs(resolved.commit, resolved.prefix, paths)
		if (!(read instanceof Map)) return { status: 'unavailable', ...unavailable(read) }
		for (const bytes of read.values())
			if (bytes && digestOf(bytes) === query.digest) return { status: 'found', digest: query.digest, bytes }
		return { status: 'not_found', code: 'changes.blob_not_found', message: 'The Asset has no file with that digest at the base.' }
	}

	return Object.freeze({ listChanges, readChangeDiff, readChangeBlob })
}
