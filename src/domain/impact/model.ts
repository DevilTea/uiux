import type { FormalEvidenceRecord } from '../evidence/schema'
import { resourceIdentityKey } from '../history/summary'

/**
 * The read-only picture of a Workspace that reference-impact analysis compares (issue #132 B6,
 * designed for reuse by the destructive-change impact of issue #75). It holds every design
 * resource the analysis follows references between, by identity, plus each resource's current
 * revision. Values are the decoded JSON as found on disk: the analysis tolerates any shape, so a
 * hand-edited or invalid file never makes it throw.
 *
 * A change is analyzed as two such pictures, `before` and `after`, that differ only in the
 * resources the change writes ({@link withResource}); a deletion is a resource absent `after`.
 */
export type ImpactWorkspace = Readonly<{
	/** The Workspace manifest (`.uiux/workspace.json`), when readable. */
	manifest?: unknown
	views: ReadonlyMap<string, unknown>
	flows: ReadonlyMap<string, unknown>
	/** Locale messages by canonical tag. */
	locales: ReadonlyMap<string, unknown>
	/** The ids of the authored Assets that exist. */
	assets: ReadonlySet<string>
	/** Review threads. They are never written by a design change, only read for what names the change. */
	reviews: readonly unknown[]
	/** The current revision of every design resource, by `resourceIdentityKey({ kind, key })`. */
	revisions: ReadonlyMap<string, string>
	/**
	 * Formal Evidence records, by artifact digest. Absent when the caller does not ask for Evidence
	 * staleness (it reads every artifact), so no Evidence impact is reported.
	 */
	evidence?: readonly ImpactEvidence[]
}>

export type ImpactEvidence = Readonly<{ digest: string; record: FormalEvidenceRecord }>

/** The design resource kinds the analysis follows. */
export const IMPACT_RESOURCE_KINDS = Object.freeze(['workspace', 'view', 'flow', 'locale', 'asset'] as const)
export type ImpactResourceKind = typeof IMPACT_RESOURCE_KINDS[number]

export function isImpactResourceKind(kind: string): kind is ImpactResourceKind {
	return (IMPACT_RESOURCE_KINDS as readonly string[]).includes(kind)
}

/**
 * The same Workspace with one resource replaced (`resource` and its `revision`) or removed
 * (`resource` undefined). An Asset is followed by identity only, so its `resource` may be any
 * defined value.
 */
export function withResource(
	workspace: ImpactWorkspace,
	identity: Readonly<{ kind: ImpactResourceKind; key: string }>,
	resource: unknown,
	revision: string | undefined,
): ImpactWorkspace {
	const present = resource !== undefined
	const revisions = new Map(workspace.revisions)
	const revisionKey = resourceIdentityKey(identity)
	if (present && revision !== undefined) revisions.set(revisionKey, revision)
	else revisions.delete(revisionKey)
	const replace = <Value>(map: ReadonlyMap<string, Value>): ReadonlyMap<string, Value> => {
		const next = new Map(map)
		if (present) next.set(identity.key, resource as Value)
		else next.delete(identity.key)
		return next
	}
	switch (identity.kind) {
		case 'workspace': return { ...workspace, revisions, manifest: resource }
		case 'view': return { ...workspace, revisions, views: replace(workspace.views) }
		case 'flow': return { ...workspace, revisions, flows: replace(workspace.flows) }
		case 'locale': return { ...workspace, revisions, locales: replace(workspace.locales) }
		case 'asset': {
			const assets = new Set(workspace.assets)
			if (present) assets.add(identity.key)
			else assets.delete(identity.key)
			return { ...workspace, revisions, assets }
		}
	}
}
