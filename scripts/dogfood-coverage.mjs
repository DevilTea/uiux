/**
 * The two coverage checks of `pnpm dogfood:check` (issue #383, Discussion #379 P3/P4; criterion 1 and 2 of
 * the acceptance list). Everything here is a pure decision on data the caller read (the served copy's
 * `GET /api/requirements`, the files under `app/pages/`, the route mapping file, the View ids), so the
 * decisions run on fakes in `tests/dogfood-check.test.ts`; `scripts/dogfood-check.mjs` does the reading.
 *
 *  - Requirement coverage ({@link assessRequirementCoverage}): the provider is readable (`status: ok`), no
 *    referenced ID is unresolved or unverified, no ID is both referenced and `noUi`, and the number of UI
 *    Rules still unreferenced (`counts.unreferenced`, that is total - noUi - referenced) did not grow
 *    against the merge base. Coverage itself is a ratchet, not 100%.
 *  - Route coverage ({@link assessRoutes}): every page under `app/pages/` maps to at least one existing
 *    View in `scripts/dogfood-routes.json`, or carries an `exempt` reason, or a `todo` that names an issue
 *    (reported as a warning, never a failure).
 */

import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** What the requirement coverage numbers are, from a `RequirementsCoverage` (Clause 01a18120-f903-7f8d-9b44-d581ab520c0d). */
export function coverageNumbers(coverage) {
	const entries = Array.isArray(coverage?.requirements) ? coverage.requirements : []
	const count = state => entries.filter(entry => entry.state === state).length
	const referenced = count('referenced')
	const noUi = count('noUi')
	const remaining = count('unreferenced')
	const total = entries.length
	const ui = total - noUi
	return { total, referenced, noUi, remaining, ui, ratio: ui === 0 ? 1 : referenced / ui }
}

const percent = ratio => `${(ratio * 100).toFixed(1)}%`

/** The one-line form of {@link coverageNumbers} used in the report, the header and the step summary. */
export function describeNumbers(numbers) {
	return `referenced ${numbers.referenced}, noUi ${numbers.noUi}, remaining ${numbers.remaining} (of ${numbers.ui} UI Rules; ratio ${percent(numbers.ratio)})`
}

const MAX_LISTED = 40

/** `kind id (view ab12cd34)` for one referrer of a requirement ID. */
const referrerLabel = referrer => referrer.kind === 'flow' ? `Flow ${String(referrer.flowId).slice(0, 8)}` : `${referrer.kind === 'variant' ? `Variant "${referrer.variantName}" of View` : 'View'} ${String(referrer.viewId).slice(0, 8)}`

function listIds(label, items) {
	const lines = items.slice(0, MAX_LISTED).map(item => `${label} ${item.id}${(item.referencedBy ?? []).length > 0 ? ` (referenced by ${item.referencedBy.map(referrerLabel).join(', ')})` : ''}`)
	if (items.length > MAX_LISTED) lines.push(`... and ${items.length - MAX_LISTED} more ${label} IDs.`)
	return lines
}

/**
 * Judges the served copy's requirement coverage.
 * `coverage` is the body of `GET /api/requirements` (or `undefined` with `error` when it could not be read);
 * `baseline` is `{ numbers, ref }` computed the same way on the merge base, or `{ reason }` when there is no
 * baseline to compare with (a first run, a base that predates requirement references, no Git history).
 * Returns `{ status: 'pass' | 'fail', numbers?, lines }`.
 * @param {{ coverage?: any, error?: string, baseline?: any }} input
 */
export function assessRequirementCoverage({ coverage, error, baseline }) {
	if (!coverage) return { status: 'fail', lines: [`the requirement coverage could not be read: ${error ?? 'no response'}`] }
	const failures = []
	if (coverage.status !== 'ok') {
		failures.push(`the requirements provider status is "${coverage.status}", not "ok": coverage is not computed${coverage.provider ? ` (provider ${JSON.stringify(coverage.provider)})` : ' (no provider configured)'}`)
	}
	const entries = Array.isArray(coverage.requirements) ? coverage.requirements : []
	const unresolved = Array.isArray(coverage.unresolved) ? coverage.unresolved : []
	const unverified = Array.isArray(coverage.unverified) ? coverage.unverified : []
	const both = entries.filter(entry => entry.state === 'noUi' && (entry.referencedBy ?? []).length > 0)
	const numbers = coverageNumbers(coverage)
	const lines = [`${describeNumbers(numbers)}; ${unresolved.length} unresolved, ${unverified.length} unverified, ${both.length} both referenced and noUi.`]
	if (unresolved.length > 0) {
		failures.push(`${unresolved.length} requirement ID(s) the Workspace names are not Rules of the provider (unresolved):`)
		failures.push(...listIds('unresolved', unresolved))
	}
	if (unverified.length > 0) {
		failures.push(`${unverified.length} referenced ID(s) could not be verified against a provider (unverified):`)
		failures.push(...listIds('unverified', unverified))
	}
	if (both.length > 0) {
		failures.push(`${both.length} ID(s) are marked noUi and also referenced by a View, Variant or Flow (a Rule is either UI or not):`)
		failures.push(...listIds('noUi+referenced', both))
	}
	if (baseline?.numbers) {
		const delta = numbers.remaining - baseline.numbers.remaining
		lines.push(`baseline (${baseline.ref}): ${describeNumbers(baseline.numbers)}.`)
		if (delta > 0) failures.push(`ratchet: ${numbers.remaining} UI Rules are left unreferenced, ${delta} more than the ${baseline.numbers.remaining} at ${baseline.ref}; reference the new Rules from a View, Variant or Flow, or mark them noUi with a reason`)
		else lines.push(delta < 0 ? `ratchet: ${-delta} fewer unreferenced UI Rules than the baseline.` : 'ratchet: no more unreferenced UI Rules than the baseline.')
		if (numbers.noUi > baseline.numbers.noUi) lines.push(`note: noUi grew by ${numbers.noUi - baseline.numbers.noUi} (from ${baseline.numbers.noUi} to ${numbers.noUi}); the ratchet does not judge it, the reviewer does.`)
	}
	else {
		lines.push(`ratchet not applied: ${baseline?.reason ?? 'no baseline'}.`)
	}
	return { status: failures.length === 0 ? 'pass' : 'fail', numbers, lines: [...lines, ...failures] }
}

// ---------------------------------------------------------------------------------------------
// Route coverage
// ---------------------------------------------------------------------------------------------

/** The file that maps the routes of `app/pages/` to dogfood Views (relative to the repository root). */
export const ROUTE_MAP_FILE = 'scripts/dogfood-routes.json'

/** The route of a page file (relative to `app/pages/`, with `/`) by Nuxt's file-based routing: `index` is its directory, `[id]` is `:id`. */
export function routeOfPage(file) {
	const segments = file.replace(/\.vue$/u, '').split('/')
	if (segments.at(-1) === 'index') segments.pop()
	const converted = segments.map(segment => segment
		.replace(/^\[\.\.\.(.+)\]$/u, ':$1(.*)*')
		.replace(/^\[\[(.+)\]\]$/u, ':$1?')
		.replace(/^\[(.+)\]$/u, ':$1'))
	return `/${converted.join('/')}`
}

/** Every `.vue` page under `pagesDirectory` as `{ file, route }`, sorted by route. */
export function enumeratePages(pagesDirectory) {
	const pages = []
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) walk(path)
			else if (entry.name.endsWith('.vue')) {
				const file = relative(pagesDirectory, path).split(sep).join('/')
				pages.push({ file, route: routeOfPage(file) })
			}
		}
	}
	walk(pagesDirectory)
	return pages.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0))
}

const isReason = value => typeof value === 'string' && value.trim() !== ''

/** The kind of a mapping entry (`views`, `exempt` or `todo`), or why it is malformed. */
function classifyEntry(entry) {
	if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return { error: 'is not an object' }
	const kinds = ['views', 'exempt', 'todo'].filter(kind => kind in entry)
	if (kinds.length !== 1) return { error: `must hold exactly one of views, exempt, todo (has ${kinds.length === 0 ? 'none' : kinds.join(', ')})` }
	const [kind] = kinds
	if (kind === 'views') {
		if (!Array.isArray(entry.views) || entry.views.length === 0) return { error: 'maps to no View (views must be a non-empty array of View ids)' }
		if (!entry.views.every(isReason)) return { error: 'has a views entry that is not a non-empty string' }
	}
	else if (kind === 'exempt' && !isReason(entry.exempt)) return { error: 'has an exemption without a reason' }
	else if (kind === 'todo' && !(isReason(entry.todo) && /#\d+/u.test(entry.todo))) return { error: 'has a todo that names no issue (write the reason with its issue number, such as "#409")' }
	return { kind }
}

/**
 * Judges the route mapping. `pages` are `{ file, route }`, `mapping` is the parsed route map file
 * (`{ routes: { "<route>": { views: [id…] } | { exempt: reason } | { todo: "reason #issue" } } }`) and `viewIds`
 * the ids of the Workspace's Views. Fails on a page with no entry, an entry for no page, a malformed entry,
 * a View id the Workspace does not have; a `todo` is a warning. Returns `{ status: 'pass' | 'warn' | 'fail', counts, lines }`.
 */
export function assessRoutes({ pages, mapping, viewIds }) {
	const routes = mapping && typeof mapping.routes === 'object' && mapping.routes !== null && !Array.isArray(mapping.routes) ? mapping.routes : undefined
	if (!routes) return { status: 'fail', counts: { mapped: 0, exempt: 0, todo: 0 }, lines: [`${ROUTE_MAP_FILE} has no "routes" object`] }
	const known = new Set(viewIds)
	const failures = []
	const warnings = []
	const counts = { mapped: 0, exempt: 0, todo: 0 }
	const pageRoutes = new Set(pages.map(page => page.route))
	for (const page of pages) {
		if (!(page.route in routes)) {
			failures.push(`UNMAPPED  ${page.route} (app/pages/${page.file}): add it to ${ROUTE_MAP_FILE} with its View ids, an exemption reason, or a todo naming an issue`)
			continue
		}
		const entry = routes[page.route]
		const { kind, error } = classifyEntry(entry)
		if (error) {
			failures.push(`INVALID   ${page.route}: the entry ${error}`)
		}
		else if (kind === 'views') {
			const unknown = entry.views.filter(id => !known.has(id))
			if (unknown.length > 0) failures.push(`UNKNOWN   ${page.route}: ${unknown.length === entry.views.length ? 'none of its Views exist' : 'View id(s) that do not exist'}: ${unknown.join(', ')}`)
			else counts.mapped += 1
		}
		else if (kind === 'exempt') counts.exempt += 1
		else {
			counts.todo += 1
			warnings.push(`TODO      ${page.route} (app/pages/${page.file}): ${entry.todo}`)
		}
	}
	for (const route of Object.keys(routes)) {
		if (!pageRoutes.has(route)) failures.push(`STALE     ${route}: ${ROUTE_MAP_FILE} maps a route that has no page under app/pages/ any more; remove the entry`)
	}
	const summary = `${pages.length} page(s): ${counts.mapped} mapped to Views, ${counts.exempt} exempt, ${counts.todo} todo (warning), ${failures.length} problem(s).`
	return { status: failures.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass', counts, lines: [summary, ...failures, ...warnings] }
}
