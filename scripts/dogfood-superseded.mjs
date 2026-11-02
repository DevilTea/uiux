/**
 * Tracked formal captures that a fresh capture of the same render context supersedes (issue #379
 * follow-up; used by `pnpm dogfood:worktree select`, procedure in docs/dogfood-worktree.md).
 *
 * `uiux artifacts gc` keeps, per View and render context, every capture of the View's current
 * revision (Rule 01a14e30-31c0-7289-a944-74af9556eabf, Notes of Feature 01a111e4-017b-79d9-94a2-fbccf1bd0dbf):
 * a Kit, Adapter, Locale or Workspace change recaptures the same View revision, so the older
 * generation stays reachable. A capture carries no capture time, so gc cannot order the two; the
 * Workbench's own freshness judgement (`evidenceFreshness`, the one `dogfood:check` uses) can. This
 * module narrows only that one root, in the dogfood tree and only for tracked captures:
 *
 * - a candidate is a tracked `formal_capture` blob that is `stale` while a `fresh` capture of the
 *   same render context (`contextKey`) stays in the tree; `unknown` freshness is never a candidate;
 * - a candidate that any other root reaches stays: a Review thread, a Checkpoint or any other file
 *   under `.uiux/` (other than the store and the Kit) that names its identity, or a blob that is kept
 *   and names it (an `interaction_replay`, say). The scan is textual and over-protects on purpose;
 * - what stays is then decided by gc itself: the candidates are deleted from a scratch tree and
 *   `uiux artifacts gc --dry-run` (empty `UIUX_HOME`) lists what no root reaches any more, so a
 *   screenshot only the candidates named is listed with them and a screenshot a kept capture also
 *   names is not;
 * - a context whose fresh captures gc itself would collect (a fresh capture of an older View revision,
 *   say) is left whole, and the run refuses outright if a context would still end up with no fresh
 *   capture after the run.
 *
 * Nothing is deleted from the repository here: the caller only lists the paths.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { BLOB_DIR, DOGFOOD_DIR, listGarbageBlobs } from './dogfood-guard.mjs'

const IDENTITY = /sha256:([0-9a-f]{64})/gu
const HEX = /^[0-9a-f]{64}$/u

/** Recursively reads the sorted keys of a JSON value into one canonical string (the same grouping as gc's `executionContext`). */
function canonical(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
	return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

function identitiesIn(bytes) {
	return new Set([...Buffer.from(bytes).toString('latin1').matchAll(IDENTITY)].map(match => match[1]))
}

/** Every blob of the store at `workspaceRoot`: `Map<hex, { bytes, references, capture? }>` (`capture` is the canonical `executionContext` of a formal capture). */
function readStore(workspaceRoot) {
	const store = new Map()
	const base = join(workspaceRoot, BLOB_DIR)
	if (!existsSync(base)) return store
	for (const shard of readdirSync(base, { withFileTypes: true })) {
		if (!shard.isDirectory() || !/^[0-9a-f]{2}$/u.test(shard.name)) continue
		for (const entry of readdirSync(join(base, shard.name), { withFileTypes: true })) {
			if (!entry.isFile() || !HEX.test(entry.name) || !entry.name.startsWith(shard.name)) continue
			const bytes = readFileSync(join(base, shard.name, entry.name))
			const references = identitiesIn(bytes)
			references.delete(entry.name)
			let capture
			if (bytes[0] === 0x7B) {
				try {
					const record = JSON.parse(bytes.toString('utf8'))
					if (record?.kind === 'formal_capture' && record.executionContext && typeof record.executionContext === 'object') capture = canonical(record.executionContext)
				}
				catch { /* not JSON: a screenshot or another blob */ }
			}
			store.set(entry.name, { bytes: bytes.byteLength, references, ...(capture === undefined ? {} : { capture }) })
		}
	}
	return store
}

/** Every `sha256:` identity named by a file under the Workspace other than the store and the Kit (Review threads, history, Views, Flows, ...). */
function identitiesOutsideStore(workspaceRoot) {
	const found = new Set()
	const root = join(workspaceRoot, DOGFOOD_DIR)
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			const rel = relative(root, path).split(sep).join('/')
			if (rel === 'artifacts' || rel === 'kit') continue
			if (entry.isDirectory()) walk(path)
			else if (entry.isFile() && lstatSync(path).size < 64 * 1024 * 1024) for (const hex of identitiesIn(readFileSync(path))) found.add(hex)
		}
	}
	if (existsSync(root)) walk(root)
	return found
}

const blobFile = (workspaceRoot, hex) => join(workspaceRoot, BLOB_DIR, hex.slice(0, 2), hex)

/**
 * Plans the superseded captures of the tree at `workspaceRoot` (a scratch directory that holds the
 * `.uiux/` as it would be committed; it is changed while planning and left with the final deletions
 * applied, so the caller discards it).
 *
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {ReadonlySet<string>} options.tracked hex digests of the blobs HEAD tracks
 * @param {ReadonlySet<string>} options.garbage hex digests `gc --dry-run` lists for the tree as it is
 * @param {(root: string) => Promise<readonly { digest: string, contextKey: string, state: string }[]>} options.readFreshness
 *   the freshness of every formal capture of the Workspace at `root` (`readFormalCaptureFreshness` of dogfood-check)
 * @param {string} options.home an empty `UIUX_HOME` for gc
 * @param {string} [options.uiuxBin]
 * @returns {Promise<{ records: string[], dependents: string[], garbage: ReadonlySet<string>, sizes: ReadonlyMap<string, number>, contexts: number }>}
 *   `records` the superseded captures, `dependents` the tracked blobs that become unreferenced with them (their
 *   screenshots), both as hex digests; `garbage` what gc lists for the tree once the records are gone (the set to
 *   judge new blobs against; `garbage` itself when there are none); `sizes` the bytes of every listed blob.
 */
export async function planSupersededCaptures({ workspaceRoot, tracked, garbage, readFreshness, home, uiuxBin }) {
	const none = { records: [], dependents: [], garbage, sizes: new Map(), contexts: 0 }
	const store = readStore(workspaceRoot)
	// Cheap exit: with at most one capture per context there is nothing to supersede, and no server to start.
	const perContext = new Map()
	for (const blob of store.values()) if (blob.capture !== undefined) perContext.set(blob.capture, (perContext.get(blob.capture) ?? 0) + 1)
	if (![...perContext.values()].some(count => count > 1)) return none

	const freshness = await readFreshness(workspaceRoot)
	const byContext = new Map()
	for (const entry of freshness) {
		const hex = /^sha256:([0-9a-f]{64})$/u.exec(entry.digest)?.[1]
		if (!hex || !store.has(hex)) continue
		byContext.set(entry.contextKey, [...(byContext.get(entry.contextKey) ?? []), { hex, state: entry.state }])
	}

	// Candidates: tracked, stale, not collected by gc already, and with a fresh capture of the context that gc keeps.
	const named = identitiesOutsideStore(workspaceRoot)
	const candidates = new Map()
	for (const [contextKey, entries] of byContext) {
		if (!entries.some(entry => entry.state === 'fresh' && !garbage.has(entry.hex))) continue
		const stale = entries.filter(entry => entry.state === 'stale' && tracked.has(entry.hex) && !garbage.has(entry.hex) && !named.has(entry.hex))
		if (stale.length > 0) candidates.set(contextKey, stale.map(entry => entry.hex))
	}
	// A kept blob that names a candidate (an `interaction_replay` or `flow_trace` of it) keeps it.
	const referrers = new Map()
	for (const [hex, blob] of store) for (const reference of blob.references) referrers.set(reference, [...(referrers.get(reference) ?? []), hex])
	const removed = () => new Set([...candidates.values()].flat())
	for (let changed = true; changed;) {
		changed = false
		const doomed = removed()
		for (const [contextKey, hexes] of candidates) {
			const kept = hexes.filter(hex => !(referrers.get(hex) ?? []).some(referrer => !doomed.has(referrer) && !garbage.has(referrer)))
			if (kept.length === hexes.length) continue
			changed = true
			if (kept.length === 0) candidates.delete(contextKey)
			else candidates.set(contextKey, kept)
			break
		}
	}
	if (candidates.size === 0) return none

	const bytes = new Map([...store].map(([hex, blob]) => [hex, blob.bytes]))
	// Delete the candidates from the scratch tree and let gc itself say what no root reaches any more.
	for (const hex of removed()) rmSync(blobFile(workspaceRoot, hex), { force: true })
	const after = listGarbageBlobs({ workspaceRoot, home, ...(uiuxBin ? { uiuxBin } : {}) })
	// Safety net: every context whose captures go keeps a fresh one that gc keeps too (candidates were chosen so that it does).
	for (const [contextKey] of candidates) {
		if (!(byContext.get(contextKey) ?? []).some(entry => entry.state === 'fresh' && store.has(entry.hex) && !after.has(entry.hex)))
			throw new Error('a render context would be left without a fresh capture; nothing was selected for deletion')
	}

	const records = [...removed()].filter(hex => tracked.has(hex)).sort()
	const dependents = [...after].filter(hex => tracked.has(hex) && !garbage.has(hex) && !removed().has(hex)).sort()
	return { records, dependents, garbage: new Set([...after, ...removed()]), sizes: bytes, contexts: candidates.size }
}
