import {
	fileSetDigest,
	inOutputDigest,
	inSourceDigest,
	productKitDataDigest,
	type ProductKitDesignSystemProvenance,
	type ProductKitProvenance,
} from '../domain/product-kit/provenance'
import type { JsonObject } from '../domain/validation'
import { parseKitBuildDeclaration } from './kit-build-declaration'
import { KIT_PACKAGE_FILENAME } from './kit-dependencies'
import { resolveKitPackage } from './kit-packages'
import { locateKitProject, type KitProject } from './kit-registry'
import {
	digestKitFile,
	kitTreeUnchanged,
	readKitFile,
	sameStamp,
	scanKitTree,
	type KitEntryStamp,
	type KitFileDigestOutcome,
	type KitTreeScan,
} from './kit-source-files'

/**
 * The most kit files one digest of Product Kit provenance covers. A kit with more has no provenance
 * computed: a digest over part of the files would claim more than it covers.
 */
export const MAX_PROVENANCE_FILES = 50_000

/** How many kit files are digested at a time. */
const HASH_CONCURRENCY = 8

/** The source and output digests of Product Kit provenance (Clause 01a11bb1-8b6e-7185-b0ac-cb84c3fcc24a). */
export type KitFileSetDigests = Readonly<{ sourceDigest: string; outputDigest: string }>

/** How one kit file is digested: `digestKitFile`, or a test's counting stand-in. */
export type KitFileHasher = (kit: KitProject, path: string) => Promise<KitFileDigestOutcome>

type CachedDigest = Readonly<{ stamp: KitEntryStamp; digest: string }>

/** What the cache keeps of one kit: the build output it was walked for, the walk, each file digest by the stamp it was read at, and the result. */
type CachedKit = Readonly<{
	output: string | undefined
	scan: KitTreeScan
	digests: ReadonlyMap<string, CachedDigest>
	result: KitFileSetDigests | undefined
}>

/**
 * The source and output digests of kit projects, cached per kit by a manifest of every kit entry
 * walked: each directory and file by its path relative to `kit/`, with its `dev`, `ino`, `size`,
 * `mtimeNs` and `ctimeNs` (`KitEntryStamp`).
 *
 * A request first reads the build declaration and checks the last walk by `lstat` alone
 * (`kitTreeUnchanged`); when nothing changed it answers from the cache without opening a file.
 * Otherwise it walks the kit again (`scanKitTree`) and digests only the files whose stamp differs
 * from the one their cached digest was read at, or that are new; files no longer walked drop out.
 * The digests are those the uncached computation gives: the same files, each digested whole.
 * Requests for a kit that arrive while one is running share it (single flight).
 *
 * Residual risk of stat-based caching: a change that keeps a file's identity, size, modification
 * and change times is not seen. `ctimeNs` cannot be set back from user space, so `touch` restoring
 * the modification time is seen; what remains is a write of the same size within the time stamp
 * granularity of the file system (whole seconds on some, nanoseconds on APFS) after the stamp was
 * taken, which the next change to the file corrects.
 */
export class KitFileDigestCache {
	/** How each kit file is digested; a test seam. */
	hashFile: KitFileHasher = digestKitFile
	private readonly kits = new Map<string, CachedKit>()
	private readonly running = new Map<string, Promise<KitFileSetDigests | undefined>>()

	/** `maxFiles` is {@link MAX_PROVENANCE_FILES} but in tests. */
	constructor(private readonly capacity = 4, private readonly maxFiles = MAX_PROVENANCE_FILES) {}

	/**
	 * The digests of the kit `project` now: `undefined` when it holds more than
	 * {@link MAX_PROVENANCE_FILES} files of one digest, or a file or directory it holds cannot be
	 * read; the digests of empty file sets when there is no kit.
	 */
	digests(project: KitProject): Promise<KitFileSetDigests | undefined> {
		if (!project.directory) return emptyDigests()
		const key = project.directory
		const running = this.running.get(key)
		if (running) return running
		const run: Promise<KitFileSetDigests | undefined> = this.compute(key, project).finally(() => {
			if (this.running.get(key) === run) this.running.delete(key)
		})
		this.running.set(key, run)
		return run
	}

	clear(): void {
		this.kits.clear()
	}

	private async compute(key: string, project: KitProject): Promise<KitFileSetDigests | undefined> {
		const output = await buildOutput(project)
		const previous = this.kits.get(key)
		if (previous && previous.output === output && await kitTreeUnchanged(project, previous.scan)) return previous.result
		let sourceFiles = 0
		let outputFiles = 0
		const scanned = await scanKitTree(
			project,
			(path, directory) => inSourceDigest(path, output) || inOutputDigest(path, directory, output),
			path => (inSourceDigest(path, output) ? ++sourceFiles : ++outputFiles) > this.maxFiles,
		)
		if (scanned.status === 'no_kit') {
			this.kits.delete(key)
			return emptyDigests()
		}
		if (scanned.status === 'unreadable') return undefined
		const { scan } = scanned
		// Over the limit: the walk stopped at the first file past it, so the files it listed alone
		// exceed the limit. The kit can drop back under it only by losing a listed file, which changes
		// the stamp of a directory the walk holds, so the next request walks it again. The directories
		// the walk never reached need no stamp (issue #211).
		if (scan.truncated) {
			this.store(key, { output, scan, digests: previous?.digests ?? new Map(), result: undefined })
			return undefined
		}
		const digests = new Map<string, CachedDigest>()
		const pending: string[] = []
		for (const [path, stamp] of scan.files) {
			const cached = previous?.digests.get(path)
			if (cached && sameStamp(cached.stamp, stamp)) digests.set(path, cached)
			else pending.push(path)
		}
		let unreadable = false
		let next = 0
		const worker = async (): Promise<void> => {
			while (!unreadable && next < pending.length) {
				const path = pending[next++]!
				const read = await this.hashFile(project, path)
				if (read.status === 'found') digests.set(path, { stamp: read.stamp, digest: read.digest })
				else unreadable = true
			}
		}
		await Promise.all(Array.from({ length: HASH_CONCURRENCY }, worker))
		// A file the walk listed but that cannot be read now makes the digests unknown, never smaller.
		if (unreadable) return undefined
		const source: Record<string, string> = {}
		const built: Record<string, string> = {}
		for (const path of scan.files.keys()) {
			const digest = digests.get(path)!.digest
			if (inSourceDigest(path, output)) source[path] = digest
			else built[path] = digest
		}
		const result = { sourceDigest: await fileSetDigest(source), outputDigest: await fileSetDigest(built) }
		this.store(key, { output, scan, digests, result })
		return result
	}

	private store(key: string, entry: CachedKit): void {
		this.kits.delete(key)
		this.kits.set(key, entry)
		while (this.kits.size > this.capacity) this.kits.delete(this.kits.keys().next().value!)
	}
}

/** The process-wide cache every Product Kit provenance computation shares. */
export const kitFileDigestCache = new KitFileDigestCache()

async function emptyDigests(): Promise<KitFileSetDigests> {
	const empty = await fileSetDigest({})
	return { sourceDigest: empty, outputDigest: empty }
}

/**
 * Product Kit provenance (Clause 01a11bb1-8b6e-7185-b0ac-cb84c3fcc24a) of the Product Kit file
 * content `productKit` and the kit project `<root>/<codeDirectoryName>/` as it is now. Every kit
 * file is walked and digested as the kit source operations read them: never through a symbolic
 * link, never inside `kit/node_modules/`, bound to the open file, and streamed, so a file of any
 * size takes part. The kit file digests come from {@link kitFileDigestCache}. Each digest is keyed
 * by kit-relative paths only, so no host path enters it. `undefined` when the Workspace root
 * cannot be read, the kit holds more than {@link MAX_PROVENANCE_FILES} files of one digest, or a kit
 * file or directory cannot be read: a digest over part of the files would claim more than it covers.
 */
export async function computeProductKitProvenance(input: Readonly<{ root: string; codeDirectoryName: string; productKit: JsonObject }>): Promise<ProductKitProvenance | undefined> {
	let project: KitProject
	try {
		project = await locateKitProject(input.root, input.codeDirectoryName)
	}
	catch {
		return undefined
	}
	const files = await kitFileDigestCache.digests(project)
	if (!files) return undefined
	return {
		dataDigest: await productKitDataDigest(input.productKit),
		outputDigest: files.outputDigest,
		sourceDigest: files.sourceDigest,
		designSystems: await designSystems(project, input.productKit.designSystems),
	}
}

/**
 * Computes the kit file digests of the Workspace at `root` into {@link kitFileDigestCache} ahead of
 * a record under the persistence lock, so that record finds them cached. Never fails.
 */
export async function warmProductKitProvenance(persistence: Readonly<{ root: string; layout: Readonly<{ codeDir?: string }> }>): Promise<void> {
	const codeDirectoryName = persistence.layout.codeDir
	if (!codeDirectoryName) return
	try {
		await kitFileDigestCache.digests(await locateKitProject(persistence.root, codeDirectoryName))
	}
	catch {
		// Best effort: the record computes what is missing.
	}
}

/** The build output directory `kit/package.json` declares, relative to `kit/`, or `undefined` without a valid declaration. */
async function buildOutput(project: KitProject): Promise<string | undefined> {
	const read = await readKitFile(project, KIT_PACKAGE_FILENAME)
	if (read.status !== 'found') return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(read.bytes))
	}
	catch {
		return undefined
	}
	const declaration = parseKitBuildDeclaration(parsed)
	return declaration.state === 'declared' ? declaration.declaration.output : undefined
}

async function designSystems(project: KitProject, names: unknown): Promise<ProductKitDesignSystemProvenance[]> {
	if (!Array.isArray(names)) return []
	const entries: ProductKitDesignSystemProvenance[] = []
	for (const name of names) {
		if (typeof name !== 'string') continue
		const resolved = await resolveKitPackage(project, name)
		// Owner ruling 4 of 2026-10-15: a version that cannot be determined is omitted.
		entries.push(resolved.status === 'resolved'
			? { package: name, ...(resolved.version ? { version: resolved.version } : {}), linked: resolved.linked }
			: { package: name, linked: false })
	}
	return entries
}
