#!/usr/bin/env node
// Import applier for the `.spec/` adoption. Temporary: delete this directory at the spec cutover.
//
// Usage: node scripts/spec-import/apply.mjs <batch.json> [--dry-run]
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
// retries a revision conflict. Run it only while no other `spec` process is running.

import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createSpecClient, SpecError } from '@deviltea/spec-tool'

const KIND_DIR = { feature: 'features', story: 'stories' }

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const batchPath = args.find(arg => !arg.startsWith('--'))
if (!batchPath) {
	console.error('Usage: node scripts/spec-import/apply.mjs <batch.json> [--dry-run]')
	process.exit(2)
}

const root = process.cwd()
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

const graph = (await client.graph.export()).data
const nodes = new Map(graph.nodes.map(node => [node.id, node]))
for (const [ref, entry] of Object.entries(refmap)) {
	const node = nodes.get(entry.id)
	if (!node || node.kind !== entry.kind)
		fail(`refmap entry ${ref} -> ${entry.kind} ${entry.id} does not exist in the workspace`)
}

const log = { created: [], updated: [], relinked: [], unchanged: [] }

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

	if (!dryRun) {
		const before = (await client.workspace.validate()).revision
		for (const [kind, units] of [['feature', batch.features ?? []], ['story', batch.stories ?? []]]) {
			for (const unit of units) {
				const path = join(root, '.spec', KIND_DIR[kind], `${refmap[unit.ref].id}.md`)
				const text = await readFile(path, 'utf8')
				const end = text.indexOf('\n---\n', 4)
				if (!text.startsWith('---\n') || end === -1)
					fail(`Cannot find the frontmatter of ${path}`)
				const next = `${text.slice(0, end + 5)}${unit.body}`
				if (next !== text)
					await writeFile(path, next)
			}
		}
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
}, null, 2))
