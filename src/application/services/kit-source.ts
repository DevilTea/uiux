import { readKitDependencyRanges } from '../../adapters/kit-dependencies'
import { locateKitProject, maskHostPaths, type KitProject } from '../../adapters/kit-registry'
import { isKitFilePath, listKitFiles, MAX_KIT_FILE_BYTES, readKitFile, readKitSourceFile, type KitFileEntry } from '../../adapters/kit-source-files'
import { componentClosure } from '../../domain/product-kit/closure'
import { addedFiles, copyPathBelowTarget, type CopyRecordEntry } from '../../domain/product-kit/copy-record'
import { componentDigest, fileDigest } from '../../domain/product-kit/digest'
import { PRODUCT_KIT_RESOURCE_KEY, validateProductKit, type ProductKit } from '../../domain/product-kit/schema'
import { isSafeRelativePath, jsonPointer, type Diagnostic } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'

/**
 * The read-only kit source operations (Feature 01a11bb1-84c5-7f0b-9acb-7fb7355f5878, Rule
 * 01a11bb1-a184-7e00-a8de-c81056ad5a35): the kit project's files (`list_kit_files`, Clause
 * 01a11bb1-b1c2-…), one kit file (`uiux://product-kit/file/{path}`, Clause 01a11bb1-b0f1-…), a
 * component's source for copying it out (`get_component_source`, Clause 01a11bb1-b227-…) and the
 * Workspace side of copy drift (`compare_component_copies`, Clause 01a11bb1-b28f-…). They share the
 * digests, the closure and the kit file reader of `uiux components` (Clause 01a11bb1-8b0c-…), so an
 * Agent's copy record matches the CLI's. Nothing is written, and no result or message names a host
 * path: every path is relative to `kit/`. The key `product-kit.source.read` is the scoped session's.
 */
type Key = typeof PRODUCT_KIT_RESOURCE_KEY
const KEY: Key = PRODUCT_KIT_RESOURCE_KEY

/** The Product Kit file fails its own validation, so it has no registry to read. */
export type KitSourceInvalid = Readonly<{ status: 'invalid'; key: Key; code: string; message: string; diagnostics: readonly Diagnostic[] }>

/**
 * A kit file above the read limit (Clause 01a13d3e-c4b5-…), refused with `kit.file_too_large` and
 * never read; `path` is relative to `kit/` and `limit` is the limit in bytes.
 */
export type KitSourceTooLarge = Readonly<{ status: 'too_large'; key: Key; code: typeof KIT_FILE_TOO_LARGE; path: string; limit: number; message: string; diagnostics: readonly Diagnostic[] }>

/** The code of a kit file read refused for its size (Clause 01a13d3e-c4b5-…). */
export const KIT_FILE_TOO_LARGE = 'kit.file_too_large'

/** `truncated` is true when the listing stopped at its entry limit (Clause 01a13d3e-c4b5-…). */
export type ListKitFilesResult = Readonly<{ status: 'listed'; key: Key; files: readonly KitFileEntry[]; truncated: boolean }>

export type KitFileRead =
	| Readonly<{ status: 'found'; key: Key; path: string; size: number; digest: string; bytes: Uint8Array }>
	| Readonly<{ status: 'not_found'; key: Key; path: string }>
	| Readonly<{ status: 'invalid_path'; key: Key; path: string; message: string }>
	| KitSourceTooLarge

/** A file's content: UTF-8 text, or base64 (`encoding: "base64"`) when its bytes are not UTF-8. */
export type KitFileContent = Readonly<{ content: string; encoding?: 'base64' }>

export type ComponentSourceFile = Readonly<{ path: string; digest: string }> & KitFileContent

/** The copy-record entry without its `target`, whose `files` keys are relative to the target directory. */
export type ComponentCopyRecordEntry = Omit<CopyRecordEntry, 'target'>

export type ComponentSource = Readonly<{
	name: string
	componentDigest: string
	requires: readonly string[]
	/** Each declared external package with the version range `kit/package.json` declares, `null` when it declares none. */
	packages: Readonly<Record<string, string | null>>
	files: readonly ComponentSourceFile[]
	copyRecordEntry: ComponentCopyRecordEntry
}>

export type GetComponentSourceResult =
	| Readonly<{ status: 'found'; key: Key; components: readonly ComponentSource[] }>
	| Readonly<{ status: 'not_found'; key: Key; components: readonly string[]; message: string }>
	| KitSourceTooLarge
	| KitSourceInvalid

/** A recorded copy as the copy record holds it; only `files` and, for the path of an `added` file, `target` are read. */
export type RecordedCopy = Readonly<{ target?: string; files: Readonly<Record<string, Readonly<{ source: string; digest: string }>>> }>

/** Whether the current Workspace original still matches the recorded digest, or its component is no longer in the registry. */
export type OriginalState = 'matches' | 'differs' | 'removed'

export type ComparedCopyFile = Readonly<{
	component: string
	/** The copied file's path relative to the product project root, as the record's `files` key. */
	path: string
	source: string
	recordedDigest: string
	original: OriginalState
	/** The Workspace original's digest, `null` when it is gone or no longer declared, absent when its component is removed. */
	originalDigest?: string | null
}>

/**
 * A file that a recorded copy's component lists in the registry and its record does not (state
 * `added`, Clause 01a11bb1-8c9b-…).
 */
export type AddedCopyFile = Readonly<{
	component: string
	/** Where `uiux components add` would copy it: relative to the product project root, under the copy's recorded `target`; `null` when the copy gives no usable `target`. */
	path: string | null
	/** The file's path relative to `kit/`. */
	source: string
	/** The Workspace original's digest now, `null` when it cannot be read. */
	originalDigest: string | null
}>

export type CompareComponentCopiesResult =
	| Readonly<{ status: 'compared'; key: Key; files: readonly ComparedCopyFile[]; added: readonly AddedCopyFile[] }>
	| KitSourceTooLarge
	| KitSourceInvalid

export type KitSourceService = Readonly<{
	listKitFiles(): Promise<ListKitFilesResult>
	readKitFile(path: string): Promise<KitFileRead>
	getComponentSource(input: Readonly<{ name: string; withRequires?: boolean }>): Promise<GetComponentSourceResult>
	compareComponentCopies(input: Readonly<{ copies: Readonly<Record<string, RecordedCopy>> }>): Promise<CompareComponentCopiesResult>
}>

const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** `bytes` as UTF-8 text, or as base64 when they are not UTF-8. */
export function kitFileContent(bytes: Uint8Array): KitFileContent {
	try {
		return { content: UTF8.decode(bytes) }
	}
	catch {
		return { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' }
	}
}

export function createKitSourceService(persistence: FileNativePersistence, options: Readonly<{ now?: () => Date }> = {}): KitSourceService {
	const now = options.now ?? (() => new Date())

	/** The refusal of the kit file `path` (relative to `kit/`) for its size; `pointer` locates it in the request. */
	function tooLarge(path: string, pointer: string): KitSourceTooLarge {
		const message = `kit/${path} is larger than ${MAX_KIT_FILE_BYTES} bytes (8 MiB), the most one kit file read returns; it was not read.`
		return { status: 'too_large', key: KEY, code: KIT_FILE_TOO_LARGE, path, limit: MAX_KIT_FILE_BYTES, message, diagnostics: [{ code: KIT_FILE_TOO_LARGE, path: pointer, message }] }
	}

	async function kitProject(): Promise<KitProject> {
		return locateKitProject(persistence.root, persistence.layout.codeDir)
	}

	/** The component registry; a missing Product Kit file has none, and an invalid one refuses with its own diagnostics. */
	async function registry(): Promise<Pick<ProductKit, 'components'> | KitSourceInvalid> {
		const read = await persistence.productKit.readInspected()
		if (!read) return { components: {} }
		const validation = validateProductKit(read.resource)
		if (validation.ok) return validation.value
		return { status: 'invalid', key: KEY, code: validation.diagnostics[0]!.code, message: 'The Product Kit file is invalid; read uiux://product-kit for its diagnostics.', diagnostics: validation.diagnostics }
	}

	return Object.freeze({
		async listKitFiles(): Promise<ListKitFilesResult> {
			const kit = await kitProject()
			const listing = await listKitFiles(kit)
			return { status: 'listed', key: KEY, files: listing.files, truncated: listing.truncated }
		},

		async readKitFile(path: string): Promise<KitFileRead> {
			const kit = await kitProject()
			if (!isKitFilePath(path))
				return { status: 'invalid_path', key: KEY, path, message: 'A kit file path is relative to kit/: no empty, ".", or ".." segment, no backslash or control character, and not inside kit/node_modules/.' }
			const read = await readKitFile(kit, path, { maxBytes: MAX_KIT_FILE_BYTES })
			if (read.status === 'too_large') return tooLarge(path, '/')
			if (read.status === 'not_found') return { status: 'not_found', key: KEY, path }
			return { status: 'found', key: KEY, path, size: read.bytes.byteLength, digest: await fileDigest(read.bytes), bytes: read.bytes }
		},

		async getComponentSource(input): Promise<GetComponentSourceResult> {
			const kit = await kitProject()
			const productKit = await registry()
			if ('status' in productKit) return productKit
			const closure = componentClosure(productKit, [input.name])
			if (!closure.ok)
				return { status: 'not_found', key: KEY, components: closure.unknown, message: `The Product Kit registry has no component ${closure.unknown.join(', ')}.` }
			const names = input.withRequires === true ? closure.components : [input.name]
			const problems: Diagnostic[] = []
			let ranges: ReadonlyMap<string, string> = new Map()
			if (names.some(name => (productKit.components[name]!.packages?.length ?? 0) > 0) && kit.directory) {
				try {
					ranges = await readKitDependencyRanges(kit.directory)
				}
				catch (error) {
					problems.push({ code: 'kit.component_invalid', path: '/', message: maskHostPaths(error instanceof Error ? error.message : String(error), [kit.realRoot, persistence.root]) })
				}
			}
			const exportedAt = now().toISOString()
			const components: ComponentSource[] = []
			for (const name of names) {
				const component = productKit.components[name]!
				const files: ComponentSourceFile[] = []
				const digests: Record<string, string> = {}
				const recordFiles: Record<string, { source: string; digest: string }> = {}
				for (const [index, source] of component.files.entries()) {
					const read = await readKitSourceFile(kit, source, { maxBytes: MAX_KIT_FILE_BYTES })
					if (read.status === 'too_large') return tooLarge(source, `${jsonPointer('/components', name)}/files/${index}`)
					if (read.status === 'not_found') {
						problems.push({ code: 'kit.component_invalid', path: `/components/${name}/files/${index}`, message: `${name} declares kit/${source}, which is not a regular file under kit/src/ reached without a symbolic link.` })
						continue
					}
					const bytes = read.bytes
					const digest = await fileDigest(bytes)
					digests[source] = digest
					// Rule 01a11bb1-a376-…: a copy keeps its path relative to kit/src/, below the target directory.
					recordFiles[copyPathBelowTarget(source)] = { source, digest }
					files.push({ path: source, digest, ...kitFileContent(bytes) })
				}
				const packages = Object.fromEntries((component.packages ?? []).map(packageName => [packageName, ranges.get(packageName) ?? null]))
				const digest = await componentDigest(digests)
				components.push({ name, componentDigest: digest, requires: component.requires ?? [], packages, files, copyRecordEntry: { componentDigest: digest, exportedAt, files: recordFiles } })
			}
			if (problems.length > 0)
				return { status: 'invalid', key: KEY, code: 'kit.component_invalid', message: problems.map(problem => problem.message).join(' '), diagnostics: problems }
			return { status: 'found', key: KEY, components }
		},

		async compareComponentCopies(input): Promise<CompareComponentCopiesResult> {
			const kit = await kitProject()
			const productKit = await registry()
			if ('status' in productKit) return productKit
			// Rule 01a11bb1-a630-… and Clause 01a11bb1-8c9b-…, the Workspace side: as `uiux components diff`
			// reads it, an original the component no longer declares, or that is gone, differs from the record.
			const files: ComparedCopyFile[] = []
			const added: AddedCopyFile[] = []
			for (const name of Object.keys(input.copies).sort()) {
				const copy = input.copies[name]!
				const recorded = copy.files
				const component = Object.hasOwn(productKit.components, name) ? productKit.components[name] : undefined
				for (const path of Object.keys(recorded).sort()) {
					const { source, digest } = recorded[path]!
					if (component === undefined) {
						files.push({ component: name, path, source, recordedDigest: digest, original: 'removed' })
						continue
					}
					const read = component.files.includes(source) ? await readKitSourceFile(kit, source, { maxBytes: MAX_KIT_FILE_BYTES }) : undefined
					if (read?.status === 'too_large') return tooLarge(source, jsonPointer(`${jsonPointer('/copies', name)}/files`, path))
					const originalDigest = read?.status === 'found' ? await fileDigest(read.bytes) : null
					files.push({ component: name, path, source, recordedDigest: digest, original: originalDigest === digest ? 'matches' : 'differs', originalDigest })
				}
				// Clause 01a11bb1-8c9b-…: the registry's files that the record does not list are `added`, at the path under the recorded target.
				if (component === undefined) continue
				const target = isSafeRelativePath(copy.target) ? copy.target : undefined
				for (const file of addedFiles({ declared: component.files, recorded: Object.values(recorded).map(entry => entry.source), target })) {
					const read = await readKitSourceFile(kit, file.source, { maxBytes: MAX_KIT_FILE_BYTES })
					if (read.status === 'too_large') return tooLarge(file.source, jsonPointer('/copies', name))
					added.push({ component: name, path: file.path ?? null, source: file.source, originalDigest: read.status === 'found' ? await fileDigest(read.bytes) : null })
				}
			}
			return { status: 'compared', key: KEY, files, added }
		},
	})
}

