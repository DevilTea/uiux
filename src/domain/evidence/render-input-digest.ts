import { createHash } from 'node:crypto'
import { canonicalJsonBytes } from '../canonical-json'

/**
 * The render-input digest of a View (Clause 01a14e30-2d4a-7ce9-ad68-58db56f36f47): `sha256:<hex>`
 * over the canonical JSON `{ ir, variants }` of the View's `ir` and `variants`, where each Variant
 * entry leaves out its `requirements`, encoded as every other canonical JSON identity is
 * (`canonicalJsonBytes`: sorted keys, one trailing newline).
 * A formal capture records it at capture time, and freshness compares it with the View's current
 * one (Rule 01a115cd-c5a5-757a-b049-b5138fe75920), so a Spec-only or metadata edit (`name`,
 * `feature`) and an edit of only requirement references leave the capture fresh. A missing member is
 * left out, as canonical JSON leaves out an undefined value; a View without one is invalid and never
 * captured.
 *
 * Server-side only (it hashes with `node:crypto`); the Workbench receives the digests from the
 * Evidence list.
 */
export function renderInputDigest(view: unknown): string {
	const record = typeof view === 'object' && view !== null && !Array.isArray(view) ? view as Readonly<{ ir?: unknown; variants?: unknown }> : {}
	const bytes = canonicalJsonBytes({ ir: record.ir, variants: withoutVariantRequirements(record.variants) })
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function withoutVariantRequirements(variants: unknown): unknown {
	if (typeof variants !== 'object' || variants === null || Array.isArray(variants)) return variants
	return Object.fromEntries(Object.entries(variants).map(([name, entry]) => {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [name, entry]
		return [name, Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'requirements'))]
	}))
}
