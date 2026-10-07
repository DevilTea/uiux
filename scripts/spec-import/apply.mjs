#!/usr/bin/env node
// Import applier for the `.spec/` adoption. Temporary: delete this directory at the spec cutover.
//
// Usage: node scripts/spec-import/apply.mjs <batch.json> [--dry-run] [--force]
//
// THE BATCH FILE IS THE SOURCE OF TRUTH FOR EVERYTHING IT NAMES. The applier overwrites the title,
// summary, Story fields, `motivates` targets and the whole Markdown body of every unit in the batch
// with the batch's values. So:
//   - make every later change to an imported unit in its batch source (and re-render the batch) or
//     in a newer batch, never by editing `.spec/` alone;
//   - never re-run an older batch after a newer batch or edit touched the same units, or it reverts
//     them. The guard below refuses that case.
//
// Guard: a batch records `baseRevision`, the `.spec/` semantic revision it was drafted against. When
// the current revision differs and applying would change anything (a semantic field, a relation or
// a body), the applier refuses unless `--force`. Rerunning a batch that is already applied changes
// nothing and is always allowed. Bump `baseRevision` to the current revision when re-drafting.
//
// A batch draft names units by local `ref` (for example `F.review.lifecycle`). Spec Tool allocates
// every UUID, so `refmap.json` (next to this script) keeps ref -> UUID for later batches; it never
// goes into `.spec/`, which is closed-world. The applier:
//   1. requires a valid workspace and checks every mapped UUID still exists with the right kind;
//   2. creates missing Features, then Stories (whose `motivates` needs existing Features), or
//      updates semantic fields and relation targets that differ from the draft, sequentially with
//      `expectedRevision` threaded through every mutation;
//   3. writes each unit's provenance into its noncanonical Markdown body, and fails unless the
//      semantic revision is unchanged by those body writes;
//   4. validates the workspace again.
// It is idempotent: rerunning the same batch changes nothing. It stops on the first error and never
// retries a revision conflict. Run it only while no other `spec` process is running. The repository
// root is resolved from this script's location, not from the working directory.

import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createSpecClient, SpecError } from '@deviltea/spec-tool'

const KIND_DIR = { feature: 'features', story: 'stories' }

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
function refuseIfStale(what) {
	if (stale && !force)
		fail(`Refusing to ${what}: the batch was drafted against revision ${batch.baseRevision ?? '(none recorded)'} but the workspace is at ${initial.revision}. Re-draft the batch against the current revision (set its baseRevision), or pass --force only if you mean to overwrite newer edits.`)
}

const graph = (await client.graph.export()).data
const nodes = new Map(graph.nodes.map(node => [node.id, node]))
for (const [ref, entry] of Object.entries(refmap)) {
	const node = nodes.get(entry.id)
	if (!node || node.kind !== entry.kind)
		fail(`refmap entry ${ref} -> ${entry.kind} ${entry.id} does not exist in the workspace`)
}

const log = { created: [], updated: [], relinked: [], unchanged: [], bodies: [] }

function resolveRef(ref, kind) {
	const entry = refmap[ref]
	if (!entry || entry.kind !== kind)
		fail(`Unknown ${kind} ref ${ref}`)
	return entry.id
}

function changedFields(node, draft, fields) {
	const changes = {}
	for (const field of fields) {
		if (node[field] !== draft[field])
			changes[field] = draft[field]
	}
	return changes
}

async function mutate(operation) {
	refuseIfStale('change semantic content')
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
		const response = await mutate(expectedRevision => client[kind].create({ ...createRequest(), expectedRevision }))
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
	await mutate(expectedRevision => client[kind].update({ id: existing.id, changes, expectedRevision }))
}

try {
	for (const feature of batch.features ?? []) {
		await upsert('feature', feature, ['title', 'summary'], () => ({ title: feature.title, summary: feature.summary }))
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
		if (isNew || dryRun)
			continue
		const current = graph.edges.filter(edge => edge.from === refmap[story.ref].id && edge.type === 'motivates').map(edge => edge.to).sort()
		if (JSON.stringify(current) !== JSON.stringify(targets)) {
			log.relinked.push(`story ${story.ref}`)
			await mutate(expectedRevision => client.graph.setRelationTargets({ sourceId: refmap[story.ref].id, type: 'motivates', targets, expectedRevision }))
		}
	}

	const before = dryRun ? undefined : (await client.workspace.validate()).revision
	const writes = []
	for (const [kind, units] of [['feature', batch.features ?? []], ['story', batch.stories ?? []]]) {
		for (const unit of units) {
			if (!refmap[unit.ref])
				continue // only in a dry run, which does not create units
			const path = join(root, '.spec', KIND_DIR[kind], `${refmap[unit.ref].id}.md`)
			const text = await readFile(path, 'utf8')
			const end = text.indexOf('\n---\n', 4)
			if (!text.startsWith('---\n') || end === -1)
				fail(`Cannot find the frontmatter of ${path}`)
			const next = `${text.slice(0, end + 5)}${unit.body}`
			if (next !== text) {
				writes.push([path, next])
				log.bodies.push(`${kind} ${unit.ref}`)
			}
		}
	}
	if (writes.length > 0)
		refuseIfStale('rewrite Markdown bodies')
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
	updated: log.updated,
	relinked: log.relinked,
	unchanged: log.unchanged.length,
	bodies: log.bodies,
	stale,
}, null, 2))
