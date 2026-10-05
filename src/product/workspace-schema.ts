import { canonicalJsonBytes } from '../domain/canonical-json'
import { validateReviewThread } from '../domain/reviews/schema'
import { isRecord } from '../domain/validation'
import { workspaceRelativePath } from '../persistence/paths'
import { defineWorkspaceSchemaPolicy, type WorkspaceMigrationStep, type WorkspaceSnapshot } from '../persistence/schema-policy'
import packageJson from '../../package.json' with { type: 'json' }

/**
 * Product-owned authority for the canonical Workspace persisted format.
 *
 * Persistence deliberately accepts an injected policy; runtime composition, init, and migration
 * entrypoints must import this module instead of inferring a version from an opened Workspace.
 */
export const CURRENT_WORKSPACE_SCHEMA_VERSION = packageJson.uiuxWorkspaceSchemaVersion

export const WORKSPACE_V1_TO_V2_STEP_ID = 'uiux.v1-to-v2'

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
		const manifestPath = workspaceRelativePath()
		const manifestBytes = next.get(manifestPath)
		if (!manifestBytes) throw new TypeError('uiux.v1-to-v2 requires .uiux/workspace.json.')
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

export const PRODUCT_WORKSPACE_SCHEMA_POLICY = defineWorkspaceSchemaPolicy({
	currentVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
	recognizedVersions: [1, 2],
	steps: [WORKSPACE_V1_TO_V2_STEP],
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
	const validation = validateReviewThread(review, { schemaVersion: 2, filename })
	if (!validation.ok)
		throw new TypeError(`uiux.v1-to-v2 produced an invalid schemaVersion 2 Review ${filename}: ${validation.diagnostics.map(item => `${item.code} at ${item.path || '/'}`).join(', ')}.`)
}

function parseJson(bytes: Uint8Array, path: string): unknown {
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
	}
	catch (cause) {
		throw new TypeError(`${path} is not valid UTF-8 JSON.`, { cause })
	}
}
