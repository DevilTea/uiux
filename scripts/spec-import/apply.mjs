#!/usr/bin/env node
// Import applier for the `.spec/` adoption. Temporary: delete this directory at the spec cutover.
//
// Usage: node scripts/spec-import/apply.mjs <batch.json> [--dry-run] [--force]
//
// THE BATCH FILE IS THE SOURCE OF TRUTH FOR EVERYTHING IT NAMES. The applier overwrites the title,
// summary, Story fields, `motivates` targets, Rule and Clause statements, Contract and Clause
// `constrains` targets and the whole Markdown body of every unit in the batch with the batch's
// values. A Feature or Contract that lists `rules` / `clauses` must list all of them: the applier
// refuses when the workspace holds a child the batch does not name, unless the batch retires it.
// A batch may retire Rules, Clauses and Scenarios (`retired: [{ ref, reason }]`, for example a Rule folded into
// a neighbor): the applier deletes each retired unit that still exists and drops it from refmap.json.
// It also puts every listed owner's Rules or Clauses in the batch's order (a presentation-only change
// that leaves the semantic revision unchanged).
//
// Scenarios (`scenarios: [{ ref, title, steps: [{ type, text }], demonstrates: [ref], group?, comments }]`)
// are created after every other unit, because `demonstrates` needs existing Rules, Clauses, Features or
// Contracts. For each Scenario the batch names, the applier overwrites its title, its complete step list,
// its `demonstrates` targets and its noncanonical preamble: the `Feature:` header line (the batch's
// `group`, else the title) and the `#` comment lines before the Scenario's tags, which carry its
// provenance (`{{<ref>}}` placeholders are replaced like in bodies). Spec Tool stores each created
// Scenario in its own `.feature` file; the applier refuses to write the preamble of a file that holds
// more than one Scenario. Scenario order is not persisted (each Scenario is its own file, and Spec Tool
// has no Scenario reorder or repack operation), so there is nothing to reorder. A Rule or Clause that a
// Scenario demonstrates cannot be deleted: retiring one is refused before any change unless every
// Scenario demonstrating it is named by the same batch without it, in which case those Scenarios are
// relinked first. So:
//   - make every later change to an imported unit in its batch source (and re-render the batch) or
//     in a newer batch, never by editing `.spec/` alone;
//   - never re-run an older batch after a newer batch or edit touched the same units, or it reverts
//     them. The guard below refuses that case.
//
// Guard: a batch records `baseRevision`, the `.spec/` semantic revision it was drafted against. When
// the current revision differs and applying would change anything (a semantic field, a relation or
// a body, a deletion or a child order), the applier refuses unless `--force`. Rerunning a batch that
// is already applied changes nothing and is always allowed. Bump `baseRevision` to the current
// revision when re-drafting. A `--dry-run` of a stale batch does not stop at the first refused
// change: it reports every change a real run would make, names the refusal, and exits 1.
//
// A batch draft names units by local `ref` (for example `F.review.lifecycle`). Spec Tool allocates
// every UUID, so `refmap.json` (next to this script) keeps ref -> UUID for later batches; it never
// goes into `.spec/`, which is closed-world. The applier:
//   1. requires a valid workspace, checks every mapped UUID still exists with the right kind, and checks
//      every Scenario draft's shape (single-line title and steps, Given* -> When+ -> Then+, at least one
//      `demonstrates` ref, single-line comments) before any change;
//   2. relinks the batch's Scenarios away from retired units, then deletes the retired Rules, Clauses and
//      Scenarios that still exist;
//   3. creates missing Features, then their Rules (in draft order), then Stories (whose `motivates`
//      needs existing Features), then Contracts (whose `constrains` needs existing Features) and
//      their Clauses (whose optional `constrains` override may name Features or Rules), or updates
//      semantic fields and relation targets that differ from the draft, sequentially with
//      `expectedRevision` threaded through every mutation, and reorders children to the draft order;
//      then creates or updates the Scenarios (title, steps) and their `demonstrates` targets;
//   4. writes each Feature, Story and Contract's provenance into its noncanonical Markdown body and each
//      Scenario's provenance into its noncanonical preamble, replacing `{{<ref>}}` placeholders with
//      the mapped UUIDs (so provenance can name units created in the same run), and fails unless the
//      semantic revision is unchanged by those writes;
//   5. validates the workspace again.
// It is idempotent: rerunning the same batch changes nothing. It stops on the first error and never
// retries a revision conflict. Run it only while no other `spec` process is running. The repository
// root is resolved from this script's location, not from the working directory.

import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createSpecClient, SpecError } from '@deviltea/spec-tool'

const KIND_DIR = { feature: 'features', story: 'stories', contract: 'contracts' }
const PLACEHOLDER = /\{\{([^{}\s]+)\}\}/g

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const force = args.includes('--force')
const batchPath = args.find(arg => !arg.startsWith('--'))
if (!batchPath) {
	console.error('Usage: node scripts/spec-import/apply.mjs <batch.json> [--dry-run] [--force]')
	process.exit(2)
}

// This script lives in <root>/scripts/spec-import/.
const root = resolve(import.meta.dirname, '..', '..')
if (!await access(join(root, '.spec', 'spec.yaml')).then(() => true, () => false)) {
	console.error(`Cannot find ${join(root, '.spec', 'spec.yaml')}; expected this script at <repository root>/scripts/spec-import/.`)
	process.exit(2)
}
const refmapPath = resolve(import.meta.dirname, 'refmap.json')
const batch = JSON.parse(await readFile(resolve(batchPath), 'utf8'))
const refmap = JSON.parse(await readFile(refmapPath, 'utf8').catch(() => '{}'))
const client = createSpecClient(root)

function fail(message) {
	throw new Error(message)
}

async function saveRefmap() {
	const sorted = Object.fromEntries(Object.entries(refmap).sort(([a], [b]) => a.localeCompare(b)))
	await writeFile(refmapPath, `${JSON.stringify(sorted, null, '\t')}\n`)
}

const initial = await client.workspace.validate()
if (!initial.valid)
	fail(`Workspace is invalid; repair it first: ${JSON.stringify(initial.issues)}`)
let revision = initial.revision
// The batch is stale when the workspace moved on since it was drafted; then it may only be a no-op.
const stale = batch.baseRevision !== initial.revision
// A dry run records what a real run would refuse instead of stopping, so it can report every change.
const refusedChanges = []
function refuseIfStale(what) {
	if (!stale || force)
		return
	if (dryRun) {
		refusedChanges.push(what)
		return
	}
	fail(`Refusing to ${what}: the batch was drafted against revision ${batch.baseRevision ?? '(none recorded)'} but the workspace is at ${initial.revision}. Re-draft the batch against the current revision (set its baseRevision), or pass --force only if you mean to overwrite newer edits.`)
}

let graph = (await client.graph.export()).data
let nodes = new Map(graph.nodes.map(node => [node.id, node]))
async function refreshGraph() {
	if (dryRun)
		return
	graph = (await client.graph.export()).data
	nodes = new Map(graph.nodes.map(node => [node.id, node]))
}
for (const [ref, entry] of Object.entries(refmap)) {
	const node = nodes.get(entry.id)
	if (!node || node.kind !== entry.kind)
		fail(`refmap entry ${ref} -> ${entry.kind} ${entry.id} does not exist in the workspace`)
}

const log = { created: [], createdByKind: {}, updated: [], relinked: [], reordered: [], deleted: [], unchanged: [], bodies: [] }

// Retired units: deleted when they still exist, never listed as a child, never re-created.
const retired = (batch.retired ?? []).map(entry => entry.ref)
const scenarios = batch.scenarios ?? []
const listedRefs = new Set([
	...(batch.features ?? []).flatMap(f => [f.ref, ...(f.rules ?? []).map(r => r.ref)]),
	...(batch.stories ?? []).map(s => s.ref),
	...(batch.contracts ?? []).flatMap(c => [c.ref, ...(c.clauses ?? []).map(cl => cl.ref)]),
	...scenarios.map(s => s.ref),
])
for (const ref of retired) {
	if (listedRefs.has(ref))
		fail(`${ref} is both retired and listed by the batch`)
}
const retiredIds = new Set(retired.filter(ref => refmap[ref]).map(ref => refmap[ref].id))

// Scenario drafts are checked before any change, so a malformed one never leaves a half-applied batch.
const ONE_LINE = /^[^\r\n\u2028\u2029]*\S[^\r\n\u2028\u2029]*$/u
function checkScenarioDraft(s) {
	const where = `Scenario ${s.ref ?? '(no ref)'}`
	if (typeof s.ref !== 'string' || !s.ref)
		fail(`${where}: missing ref`)
	if (typeof s.title !== 'string' || !ONE_LINE.test(s.title))
		fail(`${where}: the title must be one non-empty line`)
	if (s.group !== undefined && (typeof s.group !== 'string' || !ONE_LINE.test(s.group)))
		fail(`${where}: the group must be one non-empty line`)
	if (!Array.isArray(s.steps) || s.steps.length === 0)
		fail(`${where}: steps must be a non-empty array`)
	let phase = null
	let whens = 0
	let thens = 0
	for (const [i, step] of s.steps.entries()) {
		if (!step || !['given', 'when', 'then'].includes(step.type) || typeof step.text !== 'string' || !ONE_LINE.test(step.text) || Object.keys(step).length !== 2)
			fail(`${where}: step ${i} must be exactly { type: given|when|then, text: one non-empty line }`)
		if ((step.type === 'given' && phase !== null && phase !== 'given') || (step.type === 'when' && phase === 'then') || (step.type === 'then' && whens === 0))
			fail(`${where}: steps must follow Given* -> When+ -> Then+ (step ${i})`)
		phase = step.type
		if (step.type === 'when')
			whens++
		if (step.type === 'then')
			thens++
	}
	if (whens === 0 || thens === 0)
		fail(`${where}: needs at least one When and one Then step`)
	if (!Array.isArray(s.demonstrates) || s.demonstrates.length === 0 || new Set(s.demonstrates).size !== s.demonstrates.length)
		fail(`${where}: demonstrates must name at least one unit, without repeats`)
	for (const ref of s.demonstrates) {
		if (retired.includes(ref))
			fail(`${where} demonstrates ${ref}, which the batch retires`)
	}
	if (!Array.isArray(s.comments) || s.comments.some(line => typeof line !== 'string' || !ONE_LINE.test(line)))
		fail(`${where}: comments must be an array of non-empty single lines`)
}
const scenarioRefs = new Set()
for (const s of scenarios) {
	checkScenarioDraft(s)
	if (scenarioRefs.has(s.ref))
		fail(`Scenario ${s.ref} is listed twice`)
	scenarioRefs.add(s.ref)
	if (refmap[s.ref] && refmap[s.ref].kind !== 'scenario')
		fail(`${s.ref} is mapped to a ${refmap[s.ref].kind}, not a scenario`)
}
const DEMONSTRABLE = ['feature', 'rule', 'contract', 'clause']
// The demonstrates targets of a Scenario draft, or undefined when a target would be created later in a dry run.
function scenarioTargets(s) {
	if (dryRun && s.demonstrates.some(ref => !refmap[ref]))
		return undefined
	return s.demonstrates.map(ref => resolveRef(ref, DEMONSTRABLE)).sort()
}

// The persisted order of an owner's `rules:` or `clauses:` entries (presentation only).
async function persistedChildOrder(dir, ownerId, key) {
	const text = await readFile(join(root, '.spec', dir, `${ownerId}.md`), 'utf8')
	const end = text.indexOf('\n---\n', 4)
	const ids = []
	let inList = false
	for (const line of text.slice(0, end).split('\n')) {
		if (/^\S/.test(line)) {
			inList = line.startsWith(`${key}:`)
			continue
		}
		const entry = inList && /^ {2}- id: (\S+)$/.exec(line)
		if (entry)
			ids.push(entry[1])
	}
	return ids
}

function resolveRef(ref, kind) {
	const kinds = Array.isArray(kind) ? kind : [kind]
	const entry = refmap[ref]
	if (!entry || !kinds.includes(entry.kind))
		fail(`Unknown ${kinds.join(' or ')} ref ${ref}`)
	return entry.id
}

function edgeTargets(sourceId, type) {
	return graph.edges.filter(edge => edge.from === sourceId && edge.type === type).map(edge => edge.to).sort()
}

// The graph exports only effective edges, so it cannot tell an inheriting Clause from one whose
// explicit override happens to equal the Contract scope. The Contract file can: an entry under
// `clauses:` carries its own `constrains:` key only when it has an override. Returns the IDs of the
// Clauses of `contractId` that persist an override.
async function persistedOverrides(contractId) {
	const text = await readFile(join(root, '.spec', 'contracts', `${contractId}.md`), 'utf8')
	const end = text.indexOf('\n---\n', 4)
	const overrides = new Set()
	let current
	let inClauses = false
	for (const line of text.slice(0, end).split('\n')) {
		if (/^\S/.test(line)) {
			inClauses = line.startsWith('clauses:')
			current = undefined
			continue
		}
		if (!inClauses)
			continue
		const entry = /^ {2}- id: (\S+)$/.exec(line)
		if (entry)
			current = entry[1]
		else if (current && /^ {4}constrains:/.test(line))
			overrides.add(current)
	}
	return overrides
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

function changedFields(node, draft, fields) {
	const changes = {}
	for (const field of fields) {
		if (node[field] !== draft[field])
			changes[field] = draft[field]
	}
	return changes
}

async function mutate(operation, what = 'change semantic content') {
	refuseIfStale(what)
	if (dryRun)
		return undefined
	const response = await operation(revision)
	revision = response.revision
	return response
}

async function upsert(kind, draft, fields, createRequest) {
	const existing = refmap[draft.ref]
	if (!existing) {
		log.created.push(`${kind} ${draft.ref}`)
		log.createdByKind[kind] = (log.createdByKind[kind] ?? 0) + 1
		const response = await mutate(expectedRevision => client[kind].create({ ...createRequest(), expectedRevision }), `create ${kind} ${draft.ref}`)
		if (response) {
			const created = response.changedNodes.filter(node => node.kind === kind)
			if (created.length !== 1)
				fail(`Expected one created ${kind} for ${draft.ref}, got ${created.length}`)
			refmap[draft.ref] = { kind, id: created[0].id }
			await saveRefmap()
		}
		return
	}
	const changes = changedFields(nodes.get(existing.id), draft, fields)
	if (Object.keys(changes).length === 0) {
		log.unchanged.push(`${kind} ${draft.ref}`)
		return
	}
	log.updated.push(`${kind} ${draft.ref}: ${Object.keys(changes).join(', ')}`)
	await mutate(expectedRevision => client[kind].update({ id: existing.id, changes, expectedRevision }), `update ${kind} ${draft.ref}`)
}

// Rules (kind 'rule', owner Feature) or Clauses (kind 'clause', owner Contract). A Clause's optional
// `constrains` lists Feature or Rule refs and overrides the Contract scope; omitted means inherit.
async function upsertChildren(kind, ownerId, ownerRef, drafts) {
	const draftIds = []
	const overridden = kind === 'clause' && ownerId && refmap[ownerRef] ? await persistedOverrides(ownerId) : new Set()
	for (const child of drafts) {
		const existing = refmap[child.ref]
		const override = child.constrains === undefined
			? null
			: (dryRun && child.constrains.some(ref => !refmap[ref]) ? undefined : child.constrains.map(ref => resolveRef(ref, ['feature', 'rule'])).sort())
		if (!existing) {
			log.created.push(`${kind} ${child.ref}`)
			log.createdByKind[kind] = (log.createdByKind[kind] ?? 0) + 1
			const response = await mutate(expectedRevision => client[kind].create({
				ownerId,
				statement: child.statement,
				...(kind === 'clause' && override ? { constrains: override } : {}),
				expectedRevision,
			}), `create ${kind} ${child.ref}`)
			if (response) {
				const created = response.changedNodes.filter(node => node.kind === kind)
				if (created.length !== 1)
					fail(`Expected one created ${kind} for ${child.ref}, got ${created.length}`)
				refmap[child.ref] = { kind, id: created[0].id }
				await saveRefmap()
			}
			continue
		}
		if (existing.kind !== kind)
			fail(`${child.ref} is mapped to a ${existing.kind}, not a ${kind}`)
		draftIds.push(existing.id)
		const node = nodes.get(existing.id)
		if (node.ownerId !== ownerId)
			fail(`${kind} ${child.ref} belongs to ${node.ownerId}, not ${ownerRef}; move it explicitly`)
		if (node.statement !== child.statement) {
			log.updated.push(`${kind} ${child.ref}: statement`)
			await mutate(expectedRevision => client[kind].update({ id: existing.id, changes: { statement: child.statement }, expectedRevision }), `update ${kind} ${child.ref}`)
		}
		else {
			log.unchanged.push(`${kind} ${child.ref}`)
		}
		// Compare the persisted relation state, not effective edges: `override === null` means the
		// draft wants inheritance, which `setRelationTargets` restores with `targets: null` (the
		// documented inherit form); an array is a complete override. In a dry run `graph` is the
		// pre-run state, which is what the comparison needs.
		if (kind === 'clause' && override !== undefined) {
			const persisted = overridden.has(existing.id) ? edgeTargets(existing.id, 'constrains') : null
			const differs = override === null ? persisted !== null : persisted === null || !sameSet(persisted, override)
			if (differs) {
				log.relinked.push(`clause ${child.ref}: ${override === null ? 'inherit' : 'override'}`)
				await mutate(expectedRevision => client.graph.setRelationTargets({ sourceId: existing.id, type: 'constrains', targets: override, expectedRevision }), `relink clause ${child.ref}`)
			}
		}
	}
	if (ownerId) {
		// `graph` predates this owner's creations, so only children that existed before the run count.
		const extra = graph.nodes.filter(node => node.kind === kind && node.ownerId === ownerId && !draftIds.includes(node.id) && !retiredIds.has(node.id))
		if (extra.length > 0)
			fail(`${ownerRef} has ${kind}s the batch does not list: ${extra.map(node => node.id).join(', ')}`)
		// Put the children in draft order. In a dry run that would create or delete children of this
		// owner the final order is unknown, so only a run without them is compared.
		const wanted = drafts.map(child => refmap[child.ref]?.id)
		const ownerDir = kind === 'rule' ? 'features' : 'contracts'
		const current = (await persistedChildOrder(ownerDir, ownerId, `${kind}s`)).filter(id => !(dryRun && retiredIds.has(id)))
		if (wanted.every(Boolean) && wanted.length === current.length && wanted.some((id, i) => id !== current[i])) {
			log.reordered.push(`${ownerRef} ${kind}s`)
			await mutate(expectedRevision => client[kind].reorder({ ownerId, orderedIds: wanted, expectedRevision }), `reorder the ${kind}s of ${ownerRef}`)
		}
	}
}

// A retired Rule or Clause that a Scenario demonstrates cannot be deleted. When the batch names that
// Scenario without it, the Scenario is relinked to its draft targets first (they must exist already);
// any other demonstrating Scenario refuses the whole batch before a change.
const preRelink = new Map()
for (const id of retiredIds) {
	for (const edge of graph.edges.filter(e => e.type === 'demonstrates' && e.to === id)) {
		const ref = Object.keys(refmap).find(r => refmap[r].id === edge.from)
		const draft = ref && scenarios.find(s => s.ref === ref)
		const retiredRef = Object.keys(refmap).find(r => refmap[r].id === id)
		if (!draft)
			fail(`Cannot retire ${retiredRef}: Scenario ${ref ?? edge.from} demonstrates it and this batch does not name that Scenario; relink it in the batch that owns it first`)
		if (draft.demonstrates.some(r => !refmap[r]))
			fail(`Cannot retire ${retiredRef}: Scenario ${ref} demonstrates it, and its new targets do not exist yet; relink the Scenario in an earlier run`)
		preRelink.set(ref, draft)
	}
}

try {
	for (const [ref, draft] of preRelink) {
		log.relinked.push(`scenario ${ref}: demonstrates (before retiring)`)
		await mutate(expectedRevision => client.graph.setRelationTargets({ sourceId: refmap[ref].id, type: 'demonstrates', targets: scenarioTargets(draft), expectedRevision }), `relink scenario ${ref}`)
	}
	for (const ref of retired) {
		const entry = refmap[ref]
		if (!entry)
			continue // already deleted, or never created
		if (entry.kind !== 'rule' && entry.kind !== 'clause' && entry.kind !== 'scenario')
			fail(`Only Rules, Clauses and Scenarios can be retired, not ${entry.kind} ${ref}`)
		log.deleted.push(`${entry.kind} ${ref}`)
		const response = await mutate(expectedRevision => client[entry.kind].delete({ id: entry.id, expectedRevision }), `delete ${entry.kind} ${ref}`)
		if (response) {
			delete refmap[ref]
			await saveRefmap()
		}
	}

	for (const feature of batch.features ?? []) {
		await upsert('feature', feature, ['title', 'summary'], () => ({ title: feature.title, summary: feature.summary }))
	}

	// Rules: every Feature that lists `rules` owns exactly those Rules, created in draft order.
	for (const feature of batch.features ?? []) {
		if (!feature.rules)
			continue
		const ownerId = refmap[feature.ref]?.id // undefined only in a dry run that would create the Feature
		await upsertChildren('rule', ownerId, feature.ref, feature.rules)
	}

	for (const story of batch.stories ?? []) {
		const targets = dryRun && story.motivates.some(ref => !refmap[ref])
			? []
			: story.motivates.map(ref => resolveRef(ref, 'feature')).sort()
		const isNew = !refmap[story.ref]
		await upsert('story', story, ['title', 'actor', 'goal', 'value'], () => ({
			title: story.title,
			actor: story.actor,
			goal: story.goal,
			value: story.value,
			motivates: targets,
		}))
		if (isNew || (dryRun && story.motivates.some(ref => !refmap[ref])))
			continue
		const current = graph.edges.filter(edge => edge.from === refmap[story.ref].id && edge.type === 'motivates').map(edge => edge.to).sort()
		if (JSON.stringify(current) !== JSON.stringify(targets)) {
			log.relinked.push(`story ${story.ref}`)
			await mutate(expectedRevision => client.graph.setRelationTargets({ sourceId: refmap[story.ref].id, type: 'motivates', targets, expectedRevision }), `relink story ${story.ref}`)
		}
	}

	for (const contract of batch.contracts ?? []) {
		const targets = contract.constrains.map(ref => resolveRef(ref, 'feature')).sort()
		const isNew = !refmap[contract.ref]
		await upsert('contract', contract, ['title', 'summary'], () => ({ title: contract.title, summary: contract.summary, constrains: targets }))
		if (!isNew && !sameSet(edgeTargets(refmap[contract.ref].id, 'constrains'), targets)) {
			log.relinked.push(`contract ${contract.ref}`)
			await mutate(expectedRevision => client.graph.setRelationTargets({ sourceId: refmap[contract.ref].id, type: 'constrains', targets, expectedRevision }), `relink contract ${contract.ref}`)
		}
	}
	await refreshGraph()
	for (const contract of batch.contracts ?? []) {
		if (!contract.clauses)
			continue
		const ownerId = refmap[contract.ref]?.id
		await upsertChildren('clause', ownerId, contract.ref, contract.clauses)
	}

	// Scenarios last: their `demonstrates` targets must exist.
	await refreshGraph()
	for (const s of scenarios) {
		const targets = scenarioTargets(s)
		const existing = refmap[s.ref]
		if (!existing) {
			log.created.push(`scenario ${s.ref}`)
			log.createdByKind.scenario = (log.createdByKind.scenario ?? 0) + 1
			const response = await mutate(expectedRevision => client.scenario.create({ title: s.title, steps: s.steps, demonstrates: targets, expectedRevision }), `create scenario ${s.ref}`)
			if (response) {
				const created = response.changedNodes.filter(node => node.kind === 'scenario')
				if (created.length !== 1)
					fail(`Expected one created scenario for ${s.ref}, got ${created.length}`)
				refmap[s.ref] = { kind: 'scenario', id: created[0].id }
				await saveRefmap()
			}
			continue
		}
		const node = nodes.get(existing.id)
		const changes = {}
		if (node.title !== s.title)
			changes.title = s.title
		if (JSON.stringify(node.steps) !== JSON.stringify(s.steps))
			changes.steps = s.steps
		if (Object.keys(changes).length > 0) {
			log.updated.push(`scenario ${s.ref}: ${Object.keys(changes).join(', ')}`)
			await mutate(expectedRevision => client.scenario.update({ id: existing.id, changes, expectedRevision }), `update scenario ${s.ref}`)
		}
		// In a dry run `graph` predates the relink made before retiring, which already sets these targets.
		if (targets && !(dryRun && preRelink.has(s.ref)) && !sameSet(edgeTargets(existing.id, 'demonstrates'), targets)) {
			log.relinked.push(`scenario ${s.ref}: demonstrates`)
			await mutate(expectedRevision => client.graph.setRelationTargets({ sourceId: existing.id, type: 'demonstrates', targets, expectedRevision }), `relink scenario ${s.ref}`)
		}
		else if (Object.keys(changes).length === 0) {
			log.unchanged.push(`scenario ${s.ref}`)
		}
	}
	await refreshGraph()

	const before = dryRun ? undefined : (await client.workspace.validate()).revision
	const writes = []
	for (const [kind, units] of [['feature', batch.features ?? []], ['story', batch.stories ?? []], ['contract', batch.contracts ?? []]]) {
		for (const unit of units) {
			if (!refmap[unit.ref])
				continue // only in a dry run, which does not create units
			const path = join(root, '.spec', KIND_DIR[kind], `${refmap[unit.ref].id}.md`)
			const text = await readFile(path, 'utf8')
			const end = text.indexOf('\n---\n', 4)
			if (!text.startsWith('---\n') || end === -1)
				fail(`Cannot find the frontmatter of ${path}`)
			const body = unit.body.replace(PLACEHOLDER, (match, ref) => {
				if (refmap[ref])
					return refmap[ref].id
				if (dryRun)
					return match // a unit this dry run would create
				fail(`Body of ${kind} ${unit.ref} names unknown ref ${ref}`)
			})
			const next = `${text.slice(0, end + 5)}${body}`
			if (next !== text) {
				writes.push([path, next])
				log.bodies.push(`${kind} ${unit.ref}`)
			}
		}
	}
	// A Scenario's preamble is everything before its `@spec:id` tag: the storage-only `Feature:` header
	// and the `#` comment lines that carry its provenance.
	for (const s of scenarios) {
		if (!refmap[s.ref])
			continue // only in a dry run, which does not create Scenarios
		const node = nodes.get(refmap[s.ref].id)
		if (!node?.source?.path)
			fail(`Cannot find the storage file of scenario ${s.ref}`)
		const path = join(root, node.source.path)
		const text = await readFile(path, 'utf8')
		const tags = text.split('\n').filter(line => line.startsWith('  @spec:id:'))
		if (tags.length !== 1 || tags[0] !== `  @spec:id:${node.id}`)
			fail(`Scenario ${s.ref} shares ${node.source.path} with other Scenarios; its preamble is not the batch's to write`)
		const start = text.indexOf(tags[0])
		const comments = s.comments.map(line => `  # ${line.replace(PLACEHOLDER, (match, ref) => {
			if (refmap[ref])
				return refmap[ref].id
			if (dryRun)
				return match
			fail(`Comments of scenario ${s.ref} name unknown ref ${ref}`)
		})}`)
		const next = `${[`Feature: ${s.group ?? s.title}`, ...comments].join('\n')}\n${text.slice(start)}`
		if (next !== text) {
			writes.push([path, next])
			log.bodies.push(`scenario ${s.ref}`)
		}
	}
	if (writes.length > 0)
		refuseIfStale('rewrite Markdown bodies or Scenario comments')
	if (!dryRun) {
		for (const [path, next] of writes)
			await writeFile(path, next)
		const after = await client.workspace.validate()
		if (!after.valid)
			fail(`Workspace invalid after body writes: ${JSON.stringify(after.issues)}`)
		if (after.revision !== before)
			fail(`Body writes changed the semantic revision (${before} -> ${after.revision})`)
		revision = after.revision
	}
}
catch (error) {
	console.error(JSON.stringify({ error: error instanceof SpecError ? error.toJSON() : String(error?.stack ?? error), log }, null, 2))
	process.exit(1)
}

console.log(JSON.stringify({
	dryRun,
	revision,
	created: log.created.length,
	createdByKind: log.createdByKind,
	updated: log.updated,
	relinked: log.relinked,
	reordered: log.reordered,
	deleted: log.deleted,
	unchanged: log.unchanged.length,
	bodies: log.bodies,
	stale,
	...(refusedChanges.length > 0
		? { refused: `A real run would refuse ${refusedChanges.length} change(s), starting with: ${refusedChanges[0]}. The batch was drafted against revision ${batch.baseRevision ?? '(none recorded)'} but the workspace is at ${initial.revision}; re-draft it against the current revision, or pass --force only if you mean to overwrite newer edits.` }
		: {}),
}, null, 2))
if (refusedChanges.length > 0)
	process.exitCode = 1
