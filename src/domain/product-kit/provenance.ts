import { sha256Identity } from '../artifacts/schema'
import { canonicalJsonBytes } from '../canonical-json'
import { isRecord, validateDigest, Validator, jsonPointer, type JsonObject } from '../validation'

/** One `designSystems` entry of Product Kit provenance (Clause 01a11bb1-8b6e-7185-b0ac-cb84c3fcc24a). */
export type ProductKitDesignSystemProvenance = Readonly<{
	package: string
	/** The installed version; absent when none is known (the package is missing, or reached through a link out of the Workspace). */
	version?: string
	linked: boolean
}>

/**
 * Product Kit provenance (Clause 01a11bb1-8b6e-7185-b0ac-cb84c3fcc24a): `dataDigest` covers the
 * Product Kit file without `adapters`, `outputDigest` the kit build output without `*.map` files,
 * `sourceDigest` `kit/` without `node_modules/`, the build output and entries whose names begin with
 * `.`, and `designSystems` names each Design System package with its version and whether it was
 * resolved through a link. Formal capture, version records and the Handoff manifest record it
 * (Clauses 01a11bb1-8fc4-…, 01a11bb1-b6ae-… and 01a115cd-d7ba-…).
 */
export type ProductKitProvenance = Readonly<{
	dataDigest: string
	outputDigest: string
	sourceDigest: string
	designSystems: readonly ProductKitDesignSystemProvenance[]
}>

/**
 * The Workspace's current Product Kit provenance: `unavailable` when it cannot be computed now (the
 * file or a kit file cannot be read, or the kit holds too many files), so freshness judged against
 * it is unknown; else `available`.
 */
export type CurrentProductKitProvenance =
	| Readonly<{ state: 'unavailable' }>
	| Readonly<{ state: 'available'; provenance: ProductKitProvenance }>

/**
 * The members of an Evidence staleness context (and of the Evidence list) that carry `current`:
 * `{ productKit }` when available, else `{ productKitUnavailable: true }`.
 */
export function productKitFreshnessContext(current: CurrentProductKitProvenance): Readonly<{ productKit?: ProductKitProvenance; productKitUnavailable?: true }> {
	if (current.state === 'available') return { productKit: current.provenance }
	return { productKitUnavailable: true }
}

/**
 * The digest of a set of files: the `sha256:` identity of the canonical JSON of the map from each
 * file's path relative to `kit/` to its file digest, the reduction a component digest uses (Clause
 * 01a11bb1-8b0c-7590-9478-0348530b1ea7). An empty set has the digest of `{}`.
 */
export async function fileSetDigest(files: Readonly<Record<string, string>>): Promise<string> {
	return sha256Identity(canonicalJsonBytes(files))
}

/**
 * The data digest: the `sha256:` identity of the canonical JSON of the Product Kit file's content
 * without its `adapters` member. A change to the Adapter list is the Adapter provenance's to record.
 */
export async function productKitDataDigest(productKit: JsonObject): Promise<string> {
	const { adapters: _adapters, ...data } = productKit
	void _adapters
	return sha256Identity(canonicalJsonBytes(data))
}

/** True when some segment of the kit-relative `path` begins with `.`. */
function hasDotSegment(path: string): boolean {
	return path.split('/').some(segment => segment.startsWith('.'))
}

/** True when the kit-relative `path` is the build output directory `output` or lies below it. */
function insideOutput(path: string, output: string | undefined): boolean {
	return output !== undefined && (path === output || path.startsWith(`${output}/`))
}

/**
 * Whether the kit-relative `path` (a directory when `directory`) takes part in the source digest:
 * outside the build output `output` (if any), with no segment beginning with `.`. `kit/node_modules/`
 * never takes part: the kit file listing leaves it out.
 */
export function inSourceDigest(path: string, output: string | undefined): boolean {
	return !hasDotSegment(path) && !insideOutput(path, output)
}

/**
 * Whether the kit-relative `path` (a directory when `directory`) takes part in the output digest:
 * the build output `output` and what lies below it, without `*.map` files. Without a declared build
 * there is no output, and the output digest is that of the empty set.
 */
export function inOutputDigest(path: string, directory: boolean, output: string | undefined): boolean {
	if (output === undefined) return false
	if (directory) return insideOutput(path, output) || output.startsWith(`${path}/`)
	return insideOutput(path, output) && !path.endsWith('.map')
}

/**
 * Rule 01a11bb1-be4a-7f9b-9fd6-a6e71241113c: the Product Kit changed since `recorded` was taken
 * when its data or output digest differs from the current one. The source digest and the Design
 * System versions are recorded for the reader; they decide nothing here.
 */
export function productKitChanged(recorded: ProductKitProvenance, current: ProductKitProvenance): boolean {
	return recorded.dataDigest !== current.dataDigest || recorded.outputDigest !== current.outputDigest
}

/** `value` as Product Kit provenance when it has that shape, else `undefined`. */
export function readProductKitProvenance(value: unknown): ProductKitProvenance | undefined {
	const v = new Validator()
	validateProductKitProvenance(value, '', v)
	return v.diagnostics.length === 0 ? value as ProductKitProvenance : undefined
}

/** Validates the shape of Product Kit provenance at `path`. */
export function validateProductKitProvenance(input: unknown, path: string, v: Validator): void {
	const provenance = v.object(input, path)
	if (!provenance) return
	for (const key of ['dataDigest', 'outputDigest', 'sourceDigest'] as const)
		validateDigest(provenance[key], `${path}/${key}`, v)
	const designSystems = v.array(provenance.designSystems, `${path}/designSystems`)
	designSystems?.forEach((entry, index) => {
		const entryPath = jsonPointer(`${path}/designSystems`, index)
		if (!isRecord(entry)) {
			v.issue('schema.expected_object', entryPath, 'Expected an object { package, version?, linked }.')
			return
		}
		v.string(entry.package, `${entryPath}/package`, true)
		if (Object.hasOwn(entry, 'version')) v.string(entry.version, `${entryPath}/version`, true)
		if (typeof entry.linked !== 'boolean') v.issue('schema.expected_boolean', `${entryPath}/linked`, 'Expected a boolean.')
	})
}
