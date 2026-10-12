import { posix } from 'node:path'

import { canonicalJsonBytes } from '../domain/canonical-json'
import { bareSpecifierPackageName, declaredKitDependencies, KIT_PACKAGE_FILENAME } from '../adapters/kit-dependencies'
import { builtInAccessPresetsFile } from '../domain/access-presets/schema'
import { emptyProductKit } from '../domain/product-kit/schema'
import { validateReviewThread } from '../domain/reviews/schema'
import { isRecord } from '../domain/validation'
import { LEGACY_LAYOUT, layoutForSchemaVersion, V5_LAYOUT } from '../persistence/paths'
import { defineWorkspaceSchemaPolicy, type WorkspaceMigrationContext, type WorkspaceMigrationRefusal, type WorkspaceMigrationStep, type WorkspaceSnapshot } from '../persistence/schema-policy'
import packageJson from '../../package.json' with { type: 'json' }

/**
 * Product-owned authority for the canonical Workspace persisted format.
 *
 * Persistence deliberately accepts an injected policy; runtime composition, init, and migration
 * entrypoints must import this module instead of inferring a version from an opened Workspace.
 */
export const CURRENT_WORKSPACE_SCHEMA_VERSION = packageJson.uiuxWorkspaceSchemaVersion

export const WORKSPACE_V1_TO_V2_STEP_ID = 'uiux.v1-to-v2'
export const WORKSPACE_V2_TO_V3_STEP_ID = 'uiux.v2-to-v3'
export const WORKSPACE_V3_TO_V4_STEP_ID = 'uiux.v3-to-v4'

/**
 * The combined `1 -> 2` step shared by the accepted "Direct resolve" and "Review pin display hint"
 * decision groups (Part 7). It is deterministic and idempotent:
 *
 * 1. The manifest `schemaVersion` becomes `2` (the pin hint needs no review-file change: no v1
 *    file can contain `displayHint`).
 * 2. Every v1 lifecycle event entering `resolved` without a `resolution` gains
 *    `resolution: "verified"`. This is provable, not a guess: the v1 validator already requires
 *    every such event to come from ready-for-review, carry a submissionId and accept the active
 *    submission. The v2 rules for `verified` are a superset of the v1 resolve rules, so the
 *    backfill never hides a pre-existing v1 diagnostic.
 *
 * Rewritten files use the canonical persistence serialization. Every Review file that was valid
 * under v1 is re-validated under v2 before persistence writes anything.
 */
export const WORKSPACE_V1_TO_V2_STEP: WorkspaceMigrationStep = Object.freeze({
	id: WORKSPACE_V1_TO_V2_STEP_ID,
	fromVersion: 1,
	toVersion: 2,
	apply(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
		const next = new Map(snapshot)
		const manifestPath = layoutForSchemaVersion(1).manifestPath
		const manifestBytes = next.get(manifestPath)
		if (!manifestBytes) throw new TypeError(`uiux.v1-to-v2 requires ${manifestPath}.`)
		const manifest = parseJson(manifestBytes, manifestPath)
		if (!isRecord(manifest) || manifest.schemaVersion !== 1)
			throw new TypeError('uiux.v1-to-v2 applies only to a schemaVersion 1 manifest.')
		next.set(manifestPath, canonicalJsonBytes({ ...manifest, schemaVersion: 2 }))

		for (const [path, bytes] of snapshot) {
			if (!/^reviews\/[^/]+\.review\.json$/u.test(path)) continue
			let review: unknown
			try { review = parseJson(bytes, path) }
			catch { continue } // Unparseable JSON stays byte-identical and keeps its persistence diagnostic.
			const filename = path.slice('reviews/'.length)
			const validUnderV1 = validateReviewThread(review, { schemaVersion: 1, filename }).ok
			const migrated = backfillVerifiedResolutions(review)
			if (migrated === review) {
				if (validUnderV1) assertValidUnderV2(review, filename)
				continue
			}
			if (validUnderV1) assertValidUnderV2(migrated, filename)
			next.set(path, canonicalJsonBytes(migrated))
		}
		return next
	},
})

/**
 * The `2 -> 3` step shared by the accepted "Workspace-scoped Review threads and editable Review
 * messages" decision group and its retract addendum (Part 7). It changes only the manifest
 * `schemaVersion`: no v2 file can contain a Workspace anchor or message `edits`, and retract
 * changes no persisted shape. It still re-validates every Review file that was valid under v2
 * against v3 before persistence writes anything. Deterministic and idempotent.
 */
export const WORKSPACE_V2_TO_V3_STEP: WorkspaceMigrationStep = Object.freeze({
	id: WORKSPACE_V2_TO_V3_STEP_ID,
	fromVersion: 2,
	toVersion: 3,
	apply(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
		const next = new Map(snapshot)
		const manifestPath = layoutForSchemaVersion(2).manifestPath
		const manifestBytes = next.get(manifestPath)
		if (!manifestBytes) throw new TypeError(`uiux.v2-to-v3 requires ${manifestPath}.`)
		const manifest = parseJson(manifestBytes, manifestPath)
		if (!isRecord(manifest) || manifest.schemaVersion !== 2)
			throw new TypeError('uiux.v2-to-v3 applies only to a schemaVersion 2 manifest.')
		next.set(manifestPath, canonicalJsonBytes({ ...manifest, schemaVersion: 3 }))

		for (const [path, bytes] of snapshot) {
			if (!/^reviews\/[^/]+\.review\.json$/u.test(path)) continue
			let review: unknown
			try { review = parseJson(bytes, path) }
			catch { continue } // Unparseable JSON stays byte-identical and keeps its persistence diagnostic.
			const filename = path.slice('reviews/'.length)
			if (validateReviewThread(review, { schemaVersion: 2, filename }).ok) assertValidUnder(review, filename, 3, WORKSPACE_V2_TO_V3_STEP_ID)
		}
		return next
	},
})

/**
 * The manifest-only `3 -> 4` step of the accepted "Review render context" decision group (Part 7).
 * It changes only the manifest `schemaVersion`: no v3 file can contain `renderContext`, and none is
 * backfilled, since an absent context means unknown. It still re-validates every Review file that
 * was valid under v3 against v4 before persistence writes anything. Deterministic and idempotent.
 */
export const WORKSPACE_V3_TO_V4_STEP: WorkspaceMigrationStep = Object.freeze({
	id: WORKSPACE_V3_TO_V4_STEP_ID,
	fromVersion: 3,
	toVersion: 4,
	apply(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
		const next = new Map(snapshot)
		const manifestPath = layoutForSchemaVersion(3).manifestPath
		const manifestBytes = next.get(manifestPath)
		if (!manifestBytes) throw new TypeError(`uiux.v3-to-v4 requires ${manifestPath}.`)
		const manifest = parseJson(manifestBytes, manifestPath)
		if (!isRecord(manifest) || manifest.schemaVersion !== 3)
			throw new TypeError('uiux.v3-to-v4 applies only to a schemaVersion 3 manifest.')
		next.set(manifestPath, canonicalJsonBytes({ ...manifest, schemaVersion: 4 }))

		for (const [path, bytes] of snapshot) {
			if (!/^reviews\/[^/]+\.review\.json$/u.test(path)) continue
			let review: unknown
			try { review = parseJson(bytes, path) }
			catch { continue } // Unparseable JSON stays byte-identical and keeps its persistence diagnostic.
			const filename = path.slice('reviews/'.length)
			if (validateReviewThread(review, { schemaVersion: 3, filename }).ok) assertValidUnder(review, filename, 4, WORKSPACE_V3_TO_V4_STEP_ID)
		}
		return next
	},
})

/** The old layout's metadata directory, which `uiux.v4-to-v5` makes the Workspace root. */
const OLD_METADATA_DIRECTORY = LEGACY_LAYOUT.metadataDir
/** The kit project inside the old metadata directory, as a path relative to the old Workspace root. */
const OLD_KIT_DIRECTORY = `${OLD_METADATA_DIRECTORY}/${V5_LAYOUT.codeDir!}`
/** The kit project's package file, relative to the old Workspace root; `uiux migrate` only reads it. */
const OLD_KIT_PACKAGE_FILE = `${OLD_KIT_DIRECTORY}/${KIT_PACKAGE_FILENAME}`

/**
 * Where a v4 Adapter specifier goes in `schemaVersion` 5. A `./` specifier is placed by its module
 * path `<p>` normalized relative to the old Workspace root:
 *
 * - `bare`: a bare specifier, kept as it is; `packageName` is the package it names, if any;
 * - `kit`: `<p>` lies in `.uiux/kit/` (outside `.uiux/kit/node_modules/`), and `rebased` is the
 *   specifier relative to `kit/` (Clause 01a11bb1-8f5f-77ea-817b-46679c5a6475);
 * - `outside`: `uiux.v4-to-v5` refuses it (Rule 01a11bb1-9658-7f9e-972e-bd09136a5735), and
 *   `replacement` is the specifier to write by hand: `./.uiux/kit/<p>` once the module was moved
 *   (Clause 01a12626-e5c9-7753-8019-cdf82a5410ce). A path in a `node_modules/` directory, the kit
 *   project's own included, gets the bare specifier of its package instead (owner ruling 2 of
 *   https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18858856), with that package
 *   in `packageName`. The other edge forms the Contract leaves to this step: a path already under
 *   `.uiux/` keeps its place below `.uiux/kit/`, and a path that leaves the old root keeps only its
 *   file name, with `exact: false` since the module's place in the kit project is the operator's choice.
 */
export type V4AdapterSpecifierPlacement =
	| Readonly<{ kind: 'bare'; packageName?: string }>
	| Readonly<{ kind: 'kit'; rebased: string }>
	| Readonly<{ kind: 'outside'; replacement: string; exact: boolean; packageName?: string }>

export function placeV4AdapterSpecifier(specifier: string): V4AdapterSpecifierPlacement {
	if (!specifier.startsWith('./')) {
		const packageName = bareSpecifierPackageName(specifier)
		return packageName ? { kind: 'bare', packageName } : { kind: 'bare' }
	}
	const path = posix.normalize(specifier.slice(2))
	if (path === '..' || path.startsWith('../'))
		return { kind: 'outside', replacement: `./${OLD_KIT_DIRECTORY}/${posix.basename(path)}`, exact: false }
	// The innermost `node_modules/` (in any case, as the dependency guard reads it) names the package.
	const segments = path.split('/')
	const dependencyDirectory = segments.findLastIndex(segment => segment.toLowerCase() === 'node_modules')
	if (dependencyDirectory >= 0) {
		const packagePath = segments.slice(dependencyDirectory + 1).join('/')
		const packageName = bareSpecifierPackageName(packagePath)
		return packageName
			? { kind: 'outside', replacement: packagePath, exact: true, packageName }
			: { kind: 'outside', replacement: '<package>/<subpath>', exact: false }
	}
	if (path.startsWith(`${OLD_KIT_DIRECTORY}/`))
		return { kind: 'kit', rebased: `./${path.slice(OLD_KIT_DIRECTORY.length + 1)}` }
	if (path === '.' || path === OLD_METADATA_DIRECTORY || path === OLD_KIT_DIRECTORY)
		return { kind: 'outside', replacement: `./${OLD_KIT_DIRECTORY}/<module>`, exact: false }
	const inKit = path.startsWith(`${OLD_METADATA_DIRECTORY}/`) ? path.slice(OLD_METADATA_DIRECTORY.length + 1) : path
	return { kind: 'outside', replacement: `./${OLD_KIT_DIRECTORY}/${inKit}`, exact: true }
}

export const WORKSPACE_V4_TO_V5_STEP_ID = 'uiux.v4-to-v5'

/**
 * The `4 -> 5` step of Part 14 (Clause 01a11bb1-8f5f-77ea-817b-46679c5a6475), on the logical
 * snapshot: the manifest moves from `.uiux/workspace.json` to `workspace.json` without `adapters`,
 * at `schemaVersion` 5; `product-kit.json` holds those Adapters, each `./.uiux/kit/<p>` rebased to
 * `./<p>` and each bare specifier unchanged, with every other member empty; the data files keep
 * their paths, which from 5 are relative to the former `.uiux/` directory. Persistence applies the
 * move of the data directories (`FileNativePersistence.migrateWorkspace`). Deterministic and
 * idempotent; it re-validates every Review file that was valid under 4 against 5.
 *
 * `refuse`, which `uiux migrate` runs before anything is written, lists every Adapter the
 * relocated Workspace could not resolve: a `./` Adapter outside `.uiux/kit/` with its replacement
 * (Rule 01a11bb1-9658-7f9e-972e-bd09136a5735, Clause 01a12626-e5c9-7753-8019-cdf82a5410ce), and,
 * per owner ruling 2 of https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18858856
 * (Rule 01a12997-75d3-7852-93ec-46f5aa3cf98d), a bare Adapter whose package `.uiux/kit/package.json`
 * does not declare, or a `./` Adapter in `.uiux/kit/node_modules/`. It names the packages to declare,
 * gives a `./` specifier with a `node_modules` segment its bare replacement and writes no
 * `package.json` (Clause 01a1294a-1f53-7abe-8ac3-4fe4542c4618). `apply` alone never refuses, so an in-memory upgrade of a version recorded
 * before the hand edit (Rule 01a12626-6a4f-72dc-af92-67b3b6355d66) still reads: it keeps such a
 * specifier unchanged.
 */
export const WORKSPACE_V4_TO_V5_STEP: WorkspaceMigrationStep = Object.freeze({
	id: WORKSPACE_V4_TO_V5_STEP_ID,
	fromVersion: 4,
	toVersion: 5,
	async refuse(snapshot: WorkspaceSnapshot, context: WorkspaceMigrationContext): Promise<WorkspaceMigrationRefusal | undefined> {
		let declared: ReadonlySet<string> | undefined
		const isDeclared = async (packageName: string) => {
			declared ??= await readOldKitDependencies(context)
			return declared.has(packageName)
		}
		const items: { path: string; message: string }[] = []
		const toDeclare = new Set<string>()
		let toMove = false
		let toEdit = false
		for (const [index, adapter] of v4Adapters(snapshot).entries()) {
			const specifier = isRecord(adapter) ? adapter.moduleSpecifier : undefined
			if (typeof specifier !== 'string') continue
			const path = `/adapters/${index}/moduleSpecifier`
			const placement = placeV4AdapterSpecifier(specifier)
			if (placement.kind === 'kit') continue
			if (placement.kind === 'bare') {
				if (!placement.packageName) {
					toEdit = true
					items.push({ path, message: `${specifier} names no npm package, so ${OLD_KIT_PACKAGE_FILE} cannot declare it: replace it with a package specifier or a ./ module in ${OLD_KIT_DIRECTORY}/` })
				}
				else if (!await isDeclared(placement.packageName)) {
					toDeclare.add(placement.packageName)
					items.push({ path, message: `${specifier} names the package ${placement.packageName}, which ${OLD_KIT_PACKAGE_FILE} does not declare: declare it there` })
				}
				continue
			}
			toEdit = true
			if (placement.packageName !== undefined) {
				const undeclared = !await isDeclared(placement.packageName)
				if (undeclared) toDeclare.add(placement.packageName)
				items.push({ path, message: `${specifier} lies in a node_modules/ directory: replace it with ${placement.replacement}${undeclared ? ` and declare ${placement.packageName} in ${OLD_KIT_PACKAGE_FILE}` : ''}` })
				continue
			}
			toMove = true
			items.push({
				path,
				message: placement.exact
					? `${specifier} lies outside ${OLD_KIT_DIRECTORY}/: replace it with ${placement.replacement}`
					: `${specifier} lies outside ${OLD_KIT_DIRECTORY}/: move the module into ${OLD_KIT_DIRECTORY}/ and replace it with its path there, such as ${placement.replacement}`,
			})
		}
		if (items.length === 0) return undefined
		const actions = [
			...(toMove ? [`Move each ./ module into ${OLD_KIT_DIRECTORY}/.`] : []),
			...(toEdit ? [`Edit each listed specifier in ${LEGACY_LAYOUT.manifestPath} by hand as shown.`] : []),
			...(toDeclare.size > 0 ? [`Declare ${[...toDeclare].sort().join(', ')} in ${OLD_KIT_PACKAGE_FILE} (dependencies, devDependencies, peerDependencies or optionalDependencies); uiux migrate writes no package.json.`] : []),
		]
		return {
			message: `${WORKSPACE_V4_TO_V5_STEP_ID} refuses ${items.length} Adapter${items.length === 1 ? '' : 's'} that the relocated Workspace could not resolve, and nothing was written. ${actions.join(' ')} Then run uiux migrate again.`,
			items,
		}
	},

	apply(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
		const from = layoutForSchemaVersion(4)
		const to = layoutForSchemaVersion(5)
		const next = new Map(snapshot)
		const manifestBytes = next.get(from.manifestPath)
		if (!manifestBytes) throw new TypeError(`${WORKSPACE_V4_TO_V5_STEP_ID} requires ${from.manifestPath}.`)
		const manifest = parseJson(manifestBytes, from.manifestPath)
		if (!isRecord(manifest) || manifest.schemaVersion !== 4)
			throw new TypeError(`${WORKSPACE_V4_TO_V5_STEP_ID} applies only to a schemaVersion 4 manifest.`)
		if (next.has(to.manifestPath) || next.has(to.productKitPath!))
			throw new TypeError(`${WORKSPACE_V4_TO_V5_STEP_ID} found ${to.manifestPath} or ${to.productKitPath} in a schemaVersion 4 snapshot.`)
		const { adapters, ...settings } = manifest
		next.delete(from.manifestPath)
		next.set(to.manifestPath, canonicalJsonBytes({ ...settings, schemaVersion: 5 }))
		const rebased = (Array.isArray(adapters) ? adapters : []).map((adapter: unknown) => {
			if (!isRecord(adapter) || typeof adapter.moduleSpecifier !== 'string') return adapter
			const placement = placeV4AdapterSpecifier(adapter.moduleSpecifier)
			return placement.kind === 'kit' ? { ...adapter, moduleSpecifier: placement.rebased } : adapter
		})
		next.set(to.productKitPath!, canonicalJsonBytes({ ...emptyProductKit(), adapters: rebased }))

		for (const [path, bytes] of snapshot) {
			if (!/^reviews\/[^/]+\.review\.json$/u.test(path)) continue
			let review: unknown
			try { review = parseJson(bytes, path) }
			catch { continue } // Unparseable JSON stays byte-identical and keeps its persistence diagnostic.
			const filename = path.slice('reviews/'.length)
			if (validateReviewThread(review, { schemaVersion: 4, filename }).ok) assertValidUnder(review, filename, 5, WORKSPACE_V4_TO_V5_STEP_ID)
		}
		return next
	},
})

export const WORKSPACE_V5_TO_V6_STEP_ID = 'uiux.v5-to-v6'

/**
 * The `5 -> 6` step of Part 15 (Rule 01a11c09-c6b5-7a65-86fd-8b5dddf3de6e): it adds the Access
 * presets file `access-presets.json` holding the built-in Access presets (Clause
 * 01a11c09-a9a4-79b4-aab4-8734e4702b47) and otherwise changes only the manifest `schemaVersion`. The
 * layout is the same at 5 and 6, so nothing moves. Deterministic and idempotent; it re-validates
 * every Review file that was valid under 5 against 6.
 *
 * `refuse`, which `uiux migrate` runs before anything is written, refuses a schemaVersion 5
 * Workspace that already holds a presets file rather than overwrite it: UIUX writes none at 5.
 * `apply` alone never refuses, so an in-memory upgrade of a version recorded with such a file still
 * reads; it holds the built-in presets, as the migrated Workspace would.
 */
export const WORKSPACE_V5_TO_V6_STEP: WorkspaceMigrationStep = Object.freeze({
	id: WORKSPACE_V5_TO_V6_STEP_ID,
	fromVersion: 5,
	toVersion: 6,
	async refuse(snapshot: WorkspaceSnapshot): Promise<WorkspaceMigrationRefusal | undefined> {
		const presetsPath = layoutForSchemaVersion(6).accessPresetsPath!
		if (!snapshot.has(presetsPath)) return undefined
		return {
			message: `${WORKSPACE_V5_TO_V6_STEP_ID} writes ${presetsPath}, which this schemaVersion 5 Workspace already holds, and nothing was written. Move it away, then run uiux migrate again.`,
			items: [{ path: `/${presetsPath}`, message: `${presetsPath} exists before the migration that adds it.` }],
		}
	},

	apply(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
		const layout = layoutForSchemaVersion(6)
		const presetsPath = layout.accessPresetsPath!
		const next = new Map(snapshot)
		const manifestBytes = next.get(layout.manifestPath)
		if (!manifestBytes) throw new TypeError(`${WORKSPACE_V5_TO_V6_STEP_ID} requires ${layout.manifestPath}.`)
		const manifest = parseJson(manifestBytes, layout.manifestPath)
		if (!isRecord(manifest) || manifest.schemaVersion !== 5)
			throw new TypeError(`${WORKSPACE_V5_TO_V6_STEP_ID} applies only to a schemaVersion 5 manifest.`)
		next.set(layout.manifestPath, canonicalJsonBytes({ ...manifest, schemaVersion: 6 }))
		next.set(presetsPath, canonicalJsonBytes(builtInAccessPresetsFile()))

		for (const [path, bytes] of snapshot) {
			if (!/^reviews\/[^/]+\.review\.json$/u.test(path)) continue
			let review: unknown
			try { review = parseJson(bytes, path) }
			catch { continue } // Unparseable JSON stays byte-identical and keeps its persistence diagnostic.
			const filename = path.slice('reviews/'.length)
			if (validateReviewThread(review, { schemaVersion: 5, filename }).ok) assertValidUnder(review, filename, 6, WORKSPACE_V5_TO_V6_STEP_ID)
		}
		return next
	},
})

/**
 * The dependencies `.uiux/kit/package.json` declares, by the reading of the v5 dependency guard
 * (`declaredKitDependencies`). The context refuses a symbolic link or a non-regular file, and an
 * unreadable or malformed file throws, so the refusal check fails closed.
 */
async function readOldKitDependencies(context: WorkspaceMigrationContext): Promise<ReadonlySet<string>> {
	const bytes = await context.readWorkspaceFile(OLD_KIT_PACKAGE_FILE)
	return declaredKitDependencies(bytes === undefined ? undefined : new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

/** The `adapters` of a v4 snapshot's manifest, or none when the manifest is missing or unreadable. */
function v4Adapters(snapshot: WorkspaceSnapshot): readonly unknown[] {
	const bytes = snapshot.get(LEGACY_LAYOUT.manifestPath)
	if (!bytes) return []
	let manifest: unknown
	try { manifest = parseJson(bytes, LEGACY_LAYOUT.manifestPath) }
	catch { return [] }
	return isRecord(manifest) && Array.isArray(manifest.adapters) ? manifest.adapters : []
}

/**
 * The `.gitignore` rules for a `schemaVersion` 5 Workspace root (Clause
 * 01a1144e-55a3-74c4-8bf8-3205e968e275): the runtime files (with the temporary files written next
 * to the server hold and the persistence lock), `kit/node_modules/` and `kit/dist/`. `uiux migrate`
 * prints them after `uiux.v4-to-v5` and writes no `.gitignore` (Clause
 * 01a12626-e8fe-7354-aa20-31dd8491f841).
 */
export const WORKSPACE_GITIGNORE_RULES: readonly string[] = Object.freeze([
	V5_LAYOUT.serverHoldPath,
	V5_LAYOUT.metadataFilePath('.server-hold-*.tmp'),
	V5_LAYOUT.lockPath,
	V5_LAYOUT.metadataFilePath('.persistence-lock-*'),
	`${V5_LAYOUT.transactionsDir}/`,
	`${V5_LAYOUT.codeDir!}/node_modules/`,
	`${V5_LAYOUT.codeDir!}/dist/`,
])

export const PRODUCT_WORKSPACE_SCHEMA_POLICY = defineWorkspaceSchemaPolicy({
	currentVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
	recognizedVersions: [1, 2, 3, 4, 5, 6],
	steps: [WORKSPACE_V1_TO_V2_STEP, WORKSPACE_V2_TO_V3_STEP, WORKSPACE_V3_TO_V4_STEP, WORKSPACE_V4_TO_V5_STEP, WORKSPACE_V5_TO_V6_STEP],
})

/** Returns the same object when no lifecycle resolve event lacks a resolution. */
function backfillVerifiedResolutions(review: unknown): unknown {
	if (!isRecord(review) || !Array.isArray(review.history)) return review
	let changed = false
	const history = review.history.map((event: unknown) => {
		if (!isRecord(event) || event.kind !== 'lifecycle' || event.to !== 'resolved' || Object.hasOwn(event, 'resolution'))
			return event
		changed = true
		return { ...event, resolution: 'verified' }
	})
	return changed ? { ...review, history } : review
}

function assertValidUnderV2(review: unknown, filename: string): void {
	assertValidUnder(review, filename, 2, WORKSPACE_V1_TO_V2_STEP_ID)
}

function assertValidUnder(review: unknown, filename: string, schemaVersion: number, stepId: string): void {
	const validation = validateReviewThread(review, { schemaVersion, filename })
	if (!validation.ok)
		throw new TypeError(`${stepId} produced an invalid schemaVersion ${schemaVersion} Review ${filename}: ${validation.diagnostics.map(item => `${item.code} at ${item.path || '/'}`).join(', ')}.`)
}

function parseJson(bytes: Uint8Array, path: string): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
	}
	catch (cause) {
		throw new TypeError(`${path} is not valid UTF-8 JSON.`, { cause })
	}
}
