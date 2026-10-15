import { fileDigest } from '../domain/product-kit/digest'
import {
	fileSetDigest,
	inOutputDigest,
	inSourceDigest,
	productKitDataDigest,
	type ProductKitDesignSystemProvenance,
	type ProductKitProvenance,
} from '../domain/product-kit/provenance'
import { isRecord, type JsonObject } from '../domain/validation'
import { parseKitBuildDeclaration } from './kit-build-declaration'
import { KIT_PACKAGE_FILENAME } from './kit-dependencies'
import { resolveKitPackage } from './kit-packages'
import { locateKitProject, type KitProject } from './kit-registry'
import { listKitFiles, readKitFile } from './kit-source-files'

/**
 * The most kit files one digest of Product Kit provenance covers. A kit with more has no provenance
 * computed: a digest over part of the files would claim more than it covers.
 */
export const MAX_PROVENANCE_FILES = 50_000

/**
 * Product Kit provenance (Clause 01a11bb1-8b6e-7185-b0ac-cb84c3fcc24a) of the Product Kit file
 * content `productKit` and the kit project `<root>/<codeDirectoryName>/` as it is now. Every kit
 * file is listed and read as the kit source operations read them (`listKitFiles`, `readKitFile`):
 * never through a symbolic link, never inside `kit/node_modules/`, bound to the open file. Each
 * digest is keyed by kit-relative paths only, so no host path enters it. A file that disappears
 * between the listing and its read is left out. `undefined` when the Workspace root cannot be read
 * or the kit holds more than {@link MAX_PROVENANCE_FILES} files of one digest.
 */
export async function computeProductKitProvenance(input: Readonly<{ root: string; codeDirectoryName: string; productKit: JsonObject }>): Promise<ProductKitProvenance | undefined> {
	let project: KitProject
	try {
		project = await locateKitProject(input.root, input.codeDirectoryName)
	}
	catch {
		return undefined
	}
	const output = await buildOutput(project)
	const source = await digestKitFiles(project, path => inSourceDigest(path, output))
	const built = await digestKitFiles(project, (path, directory) => inOutputDigest(path, directory, output))
	if (source === undefined || built === undefined) return undefined
	return {
		dataDigest: await productKitDataDigest(input.productKit),
		outputDigest: built,
		sourceDigest: source,
		designSystems: await designSystems(project, input.productKit.designSystems),
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

async function digestKitFiles(project: KitProject, include: (path: string, directory: boolean) => boolean): Promise<string | undefined> {
	const listing = await listKitFiles(project, MAX_PROVENANCE_FILES, include)
	if (listing.truncated) return undefined
	const digests: Record<string, string> = {}
	for (const file of listing.files) {
		const read = await readKitFile(project, file.path, { maxBytes: Number.POSITIVE_INFINITY })
		if (read.status === 'found') digests[file.path] = await fileDigest(read.bytes)
	}
	return fileSetDigest(digests)
}

async function designSystems(project: KitProject, names: unknown): Promise<ProductKitDesignSystemProvenance[]> {
	if (!Array.isArray(names)) return []
	const entries: ProductKitDesignSystemProvenance[] = []
	for (const name of names) {
		if (typeof name !== 'string') continue
		const resolved = await resolveKitPackage(project, name)
		entries.push(resolved.status === 'resolved'
			? { package: name, ...(resolved.version ? { version: resolved.version } : {}), linked: resolved.linked }
			: { package: name, linked: false })
	}
	return entries
}

/** The parts of the file-native persistence that Product Kit provenance reads. */
export type ProductKitProvenanceSource = Readonly<{
	root: string
	layout: Readonly<{ productKitPath?: string; codeDir?: string }>
	readOptionalBytesUnlocked(relativePath: string): Promise<Uint8Array | undefined>
}>

/**
 * The Product Kit provenance of the Workspace `persistence` selects, for a caller that holds its
 * persistence lock (a version or Checkpoint record): the Product Kit file read under that lock.
 * `undefined` for a Workspace below `schemaVersion` 5, which has no Product Kit file, or when the
 * file is missing or not a JSON object.
 */
export async function workspaceProductKitProvenanceUnlocked(persistence: ProductKitProvenanceSource): Promise<ProductKitProvenance | undefined> {
	const { productKitPath, codeDir } = persistence.layout
	if (!productKitPath || !codeDir) return undefined
	const bytes = await persistence.readOptionalBytesUnlocked(productKitPath)
	if (!bytes) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes))
	}
	catch {
		return undefined
	}
	if (!isRecord(parsed)) return undefined
	return computeProductKitProvenance({ root: persistence.root, codeDirectoryName: codeDir, productKit: parsed as JsonObject })
}

/**
 * The `productKit` member of a version or Checkpoint record (Clause 01a11bb1-b6ae-7cf7-9838-
 * 9628757d1190), for a caller that holds the persistence lock: `{ productKit }`, or `{}` when the
 * Workspace has none or it cannot be computed, so recording a version never fails for it.
 */
export async function productKitRecordFieldUnlocked(persistence: ProductKitProvenanceSource): Promise<Readonly<{ productKit?: JsonObject }>> {
	try {
		const productKit = await workspaceProductKitProvenanceUnlocked(persistence)
		return productKit ? { productKit: productKit as unknown as JsonObject } : {}
	}
	catch {
		return {}
	}
}
