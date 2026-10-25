import * as fs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { sha256Identity } from '../../domain/artifacts/schema'
import type { AdapterManifest } from '../../domain/adapters/schema'
import type { ValidatedAdapterEntry } from '../../adapters/resolution'
import type { JsonObject } from '../../domain/validation'

/** One implementation source of a mapped Widget type: a file or a provenance-only URL. */
export type AdapterSourceRef = NonNullable<AdapterManifest['sources']>[string]['semantic']

/** The origin a Workspace file is traced to, as the entry-module fallback names it (Rule 01a115cd-cbcc-7ae2-856e-b0fe1248c1ac). */
export const WORKSPACE_SOURCE_ORIGIN = '@workspace'

/**
 * What one Adapter-mapped source became at export (Rules 01a115cd-cbcc-7ae2-856e-b0fe1248c1ac,
 * 01a11a5a-58c6-70bd-9a05-54e533e57c53 and 01a11add-f389-70cc-8449-6ae596044963): `bytes` is the file to
 * snapshot, present only for a `materialized` source. `provenance` is complete except for `selection`,
 * which the caller adds.
 */
export type ResolvedAdapterSource = Readonly<{
	availability: 'materialized' | 'provenance-only' | 'unavailable'
	provenance: JsonObject
	bytes?: Uint8Array
}>

type PackageRoot = Readonly<{ directory: string; name?: string; version?: string }>

type PackageManifestFields = Readonly<{ name?: string; version?: string }>

async function readPackageFields(directory: string): Promise<PackageManifestFields | undefined> {
	try {
		const parsed = JSON.parse(await fs.readFile(join(directory, 'package.json'), 'utf8')) as unknown
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
		const record = parsed as Record<string, unknown>
		return {
			...(typeof record.name === 'string' && record.name ? { name: record.name } : {}),
			...(typeof record.version === 'string' && record.version ? { version: record.version } : {}),
		}
	}
	catch {
		return undefined
	}
}

/** The directory of the nearest `package.json` at or above `path`, with its name and version. */
async function nearestPackageRoot(path: string): Promise<PackageRoot | undefined> {
	let directory = dirname(path)
	while (true) {
		const fields = await readPackageFields(directory)
		if (fields) return { directory, ...fields }
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

/** The package `name` as Node module resolution finds it from `base`: the nearest `node_modules/<name>` up the tree. */
async function findInstalledPackage(base: string, name: string): Promise<PackageRoot | undefined> {
	let directory = base
	while (true) {
		const candidate = join(directory, 'node_modules', ...name.split('/'))
		const fields = await readPackageFields(candidate)
		if (fields) return { directory: await fs.realpath(candidate).catch(() => candidate), ...fields }
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Resolves the mapped sources of validated Adapter entries (Clause 01a11a5a-45a7-7139-ac1c-d3881976eb71):
 * a file reference's `path` is relative to the root of its `package` as Node module resolution finds it
 * from the Adapter's root, else the package root of a package Adapter, else `kit/` for a `./` Adapter.
 * `kitRoot` is that `kit/` directory.
 */
export function createAdapterSourceResolver(kitRoot: string) {
	const adapterRoots = new Map<string, Promise<PackageRoot | undefined>>()

	function adapterRootOf(entry: ValidatedAdapterEntry): Promise<PackageRoot | undefined> {
		const key = entry.resolvedModule.resolvedPath
		let root = adapterRoots.get(key)
		if (!root) {
			root = entry.selection.moduleSpecifier.startsWith('./')
				? fs.realpath(kitRoot).then(directory => ({ directory }), () => undefined)
				: nearestPackageRoot(entry.resolvedModule.resolvedPath)
			adapterRoots.set(key, root)
		}
		return root
	}

	return {
		async resolve(entry: ValidatedAdapterEntry, ref: AdapterSourceRef): Promise<ResolvedAdapterSource> {
			if ('url' in ref) return { availability: 'provenance-only', provenance: { url: ref.url } }
			const adapterRoot = await adapterRootOf(entry)
			let root: PackageRoot | undefined
			if (ref.package === undefined || ref.package === adapterRoot?.name) root = adapterRoot
			else if (adapterRoot) root = await findInstalledPackage(adapterRoot.directory, ref.package)
			const origin = ref.package ?? root?.name ?? WORKSPACE_SOURCE_ORIGIN
			const named: JsonObject = { package: origin, path: ref.path, ...(root?.version ? { revision: root.version } : {}) }
			if (!root) return { availability: 'unavailable', provenance: named }
			if (ref.embed === false) return { availability: 'provenance-only', provenance: named }
			let bytes: Uint8Array
			try {
				const file = await fs.realpath(join(root.directory, ...ref.path.split('/')))
				// A link out of the root is no file of that root; its target is not described or read.
				if (!isInside(root.directory, file)) return { availability: 'unavailable', provenance: named }
				bytes = await fs.readFile(file)
			}
			catch {
				return { availability: 'unavailable', provenance: named }
			}
			const identity = await sha256Identity(bytes)
			return { availability: 'materialized', provenance: { ...named, revision: root.version ?? identity }, bytes }
		},
	}
}
