import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { readKitDependencyRanges } from '../adapters/kit-dependencies'
import { locateKitProject, type KitProject } from '../adapters/kit-registry'
import { readKitSourceFile } from '../adapters/kit-source-files'
import { componentClosure, componentPackages, componentsRequiring } from '../domain/product-kit/closure'
import {
	COPY_RECORD_FILENAME,
	copyDestination,
	driftState,
	DRIFT_STATES,
	emptyCopyRecord,
	serializeCopyRecord,
	validateCopyRecord,
	type CopyRecord,
	type CopyRecordEntry,
	type DriftState,
} from '../domain/product-kit/copy-record'
import { componentDigest, fileDigest } from '../domain/product-kit/digest'
import { validateProductKit, type ProductKit } from '../domain/product-kit/schema'
import { isSafeRelativePath } from '../domain/validation'
import { isSameOrInside, realFuturePath } from '../server/access/store'
import { selectCliWorkspace } from './workspace-selection'

/**
 * `uiux components list|add|diff` (Clauses 01a11bb1-9b24-…, 01a11bb1-9b89-…, 01a11bb1-9bef-… and
 * 01a11bb1-9c51-…): copying Product Kit components out of the Workspace's `kit/` into a product
 * project, and reporting how the copies drifted. The commands read `product-kit.json` and `kit/`
 * directly and write only into the product project, so they act with the host user's file access
 * and need no member credential (Rule 01a11bb1-a691-704d-b0bd-94fb59896ede). `add` is the only way
 * UIUX writes into a product project (Rule 01a11bb1-a56c-7a63-9e5e-3ca8c7c4950c), and the copy
 * record it keeps there is the only record of copies (Rule 01a11bb1-a5cf-7723-8b36-e6dc808381e1).
 *
 * Containment: a source file is read only when it is a regular file under the real `kit/src/`
 * reached without a symbolic link (`readKitSourceFile`). In the product project, no path between the
 * project root and a file it reads or writes may be a symbolic link, every target lies strictly
 * inside the project, and neither the project nor a target may lie inside the Workspace.
 *
 * Returns the exit code: 0 on success, 1 when refused or when `diff --check` finds drift, and 2 for
 * invalid usage or an unusable Workspace or product project.
 */
export type ComponentsCommandOptions = Readonly<{
	/** The arguments after `components`. */
	argv: readonly string[]
	cwd?: string
	stdout?: (line: string) => void
	stderr?: (line: string) => void
	/** Test seam: the time recorded as `exportedAt`. */
	now?: () => Date
	/** Test seam: the Git toplevel of a directory, or `undefined` outside a Git repository. */
	gitToplevel?: (directory: string) => string | undefined
}>

const USAGE = [
	'uiux components list [--workspace <dir>]',
	'uiux components add <name...> --to <dir> [--project <dir>] [--force] [--workspace <dir>]',
	'uiux components diff [--project <dir>] [--workspace <dir>] [--check]',
]

/** A refusal: its message is printed, and nothing (more) is written. */
class Refusal extends Error {
	constructor(message: string, readonly exitCode = 1) {
		super(message)
		this.name = 'Refusal'
	}
}

type Context = Readonly<{
	cwd: string
	out: (line: string) => void
	now: () => Date
	gitToplevel: (directory: string) => string | undefined
}>

export async function runComponentsCommand(options: ComponentsCommandOptions): Promise<number> {
	const out = options.stdout ?? (line => console.log(line))
	const err = options.stderr ?? (line => console.error(line))
	const context: Context = {
		cwd: resolve(options.cwd ?? process.cwd()),
		out,
		now: options.now ?? (() => new Date()),
		gitToplevel: options.gitToplevel ?? gitToplevel,
	}
	const [subcommand, ...args] = options.argv
	try {
		if (subcommand === 'list') return await listCommand(parse(args, { workspace: 'string' }, false), context)
		if (subcommand === 'add') return await addCommand(parse(args, { workspace: 'string', to: 'string', project: 'string', force: 'boolean' }, true), context)
		if (subcommand === 'diff') return await diffCommand(parse(args, { workspace: 'string', project: 'string', check: 'boolean' }, false), context)
		throw new Refusal(`components takes list, add or diff:\n  ${USAGE.join('\n  ')}`, 2)
	}
	catch (error) {
		if (!(error instanceof Refusal)) throw error
		for (const line of error.message.split('\n')) err(line.startsWith('  ') ? line : `uiux: ${line}`)
		return error.exitCode
	}
}

type ParsedArguments = Readonly<{ values: Readonly<Record<string, string | boolean | undefined>>; positionals: readonly string[] }>

function parse(args: readonly string[], spec: Readonly<Record<string, 'string' | 'boolean'>>, positionals: boolean): ParsedArguments {
	try {
		const parsed = parseArgs({
			args: [...args],
			options: Object.fromEntries(Object.entries(spec).map(([name, type]) => [name, { type }])),
			allowPositionals: positionals,
			strict: true,
		})
		for (const [name, value] of Object.entries(parsed.values)) {
			if (typeof value === 'string' && (value === '' || value.startsWith('-')))
				throw new Error(`--${name} needs a value`)
		}
		return parsed
	}
	catch (error) {
		throw new Refusal(`${error instanceof Error ? error.message : String(error)}.\n  ${USAGE.join('\n  ')}`, 2)
	}
}

function stringOption(parsed: ParsedArguments, name: string): string | undefined {
	const value = parsed.values[name]
	return typeof value === 'string' ? value : undefined
}

// ---------------------------------------------------------------------------------------------
// The Workspace side: the Product Kit file and `kit/`.

type LoadedKit = Readonly<{ root: string; realRoot: string; kit: ProductKit; project: KitProject }>

async function loadProductKit(workspace: string | undefined, context: Context): Promise<LoadedKit> {
	const selection = selectCliWorkspace(workspace, context.cwd)
	if (!selection.ok) throw new Refusal(selection.message, 2)
	const { root, layout } = selection
	if (layout.productKitPath === undefined || layout.codeDir === undefined)
		throw new Refusal(`The Workspace ${root} is from before schemaVersion 5 and has no Product Kit; run uiux migrate first.`, 2)
	const path = join(root, layout.productKitPath)
	const info = await lstat(path).catch(() => undefined)
	if (!info?.isFile()) throw new Refusal(`${layout.productKitPath} of the Workspace ${root} is missing or not a regular file.`)
	let input: unknown
	try {
		input = JSON.parse(await readFile(path, 'utf8'))
	}
	catch {
		throw new Refusal(`${layout.productKitPath} of the Workspace ${root} could not be read as JSON.`)
	}
	const validation = validateProductKit(input)
	if (!validation.ok)
		throw new Refusal([`${layout.productKitPath} of the Workspace ${root} is invalid:`, ...validation.diagnostics.map(d => `  ${d.path || '/'}: ${d.message}`)].join('\n'))
	const project = await locateKitProject(root, layout.codeDir)
	return { root, realRoot: project.realRoot, kit: validation.value, project }
}

// ---------------------------------------------------------------------------------------------
// The product project side.

/**
 * The product project (Clause 01a11bb1-9c51-7b58-b885-25c61a0fd902): `--project <dir>` when given,
 * otherwise the nearest directory holding a `package.json` at or above `start`, otherwise the Git
 * toplevel. Returns its path as chosen and its real path.
 */
async function selectProductProject(project: string | undefined, start: string, context: Context, workspace: LoadedKit): Promise<Readonly<{ chosen: string; real: string }>> {
	let chosen: string | undefined
	if (project !== undefined) {
		chosen = resolve(context.cwd, project)
		if (!(await stat(chosen).catch(() => undefined))?.isDirectory())
			throw new Refusal(`The product project ${chosen} is not a directory.`, 2)
	}
	else {
		for (let directory = start; ; directory = dirname(directory)) {
			if ((await lstat(join(directory, 'package.json')).catch(() => undefined)) !== undefined) {
				chosen = directory
				break
			}
			if (dirname(directory) === directory) break
		}
		chosen ??= context.gitToplevel(await nearestExistingDirectory(start))
		if (chosen === undefined)
			throw new Refusal(`No product project found: no package.json at or above ${start} and no Git repository. Name one with --project <dir>.`, 2)
	}
	const real = await realpath(chosen)
	if (isSameOrInside(workspace.realRoot, real))
		throw new Refusal(`The product project ${real} lies inside the Workspace ${workspace.realRoot}; the copy record is never kept in a Workspace.`, 2)
	return { chosen, real }
}

async function nearestExistingDirectory(path: string): Promise<string> {
	for (let directory = path; ; directory = dirname(directory)) {
		if ((await stat(directory).catch(() => undefined))?.isDirectory()) return directory
		if (dirname(directory) === directory) return directory
	}
}

/** The project-relative (`/`-separated) path of `path`, or `undefined` when it is not strictly inside the project. */
function projectRelative(realProject: string, path: string): string | undefined {
	const rel = relative(realProject, path)
	if (rel === '' || !isSameOrInside(realProject, path)) return undefined
	const posixRel = rel.split(sep).join('/')
	return isSafeRelativePath(posixRel) ? posixRel : undefined
}

type PathState = 'absent' | 'file' | 'directory' | 'other'

/**
 * What lies at the project-relative path `rel`, refusing a symbolic link anywhere between the
 * project root and it: `uiux components` never follows a link in the product project.
 */
async function inspectProjectPath(realProject: string, rel: string): Promise<PathState> {
	const segments = rel.split('/')
	let path = realProject
	for (const [index, segment] of segments.entries()) {
		path = join(path, segment)
		const info = await lstat(path).catch(() => undefined)
		if (!info) return 'absent'
		if (info.isSymbolicLink())
			throw new Refusal(`${segments.slice(0, index + 1).join('/')} in the product project is a symbolic link; uiux components does not follow links there (needed for ${rel}).`)
		if (index === segments.length - 1) return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other'
		if (!info.isDirectory()) return 'other'
	}
	return 'other'
}

/** The bytes of the project file `rel`, or `undefined` when it is not a regular file. */
async function readProjectFile(realProject: string, rel: string): Promise<Uint8Array | undefined> {
	if (await inspectProjectPath(realProject, rel) !== 'file') return undefined
	return readFile(join(realProject, ...rel.split('/')))
}

async function writeProjectFile(realProject: string, rel: string, bytes: Uint8Array): Promise<void> {
	const segments = rel.split('/')
	let path = realProject
	for (const [index, segment] of segments.slice(0, -1).entries()) {
		path = join(path, segment)
		await mkdir(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== 'EEXIST') throw error
		})
		const info = await lstat(path)
		if (info.isSymbolicLink() || !info.isDirectory())
			throw new Refusal(`${segments.slice(0, index + 1).join('/')} in the product project is not a directory reached without a symbolic link.`)
	}
	const handle = await open(join(path, segments.at(-1)!), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o666)
	try {
		await handle.writeFile(bytes)
	}
	finally {
		await handle.close()
	}
}

/** Removes the project file `rel`, then the directories it leaves empty, strictly below `stopAt`. */
async function removeProjectFile(realProject: string, rel: string, stopAt: string): Promise<void> {
	if (await inspectProjectPath(realProject, rel) !== 'file') return
	await rm(join(realProject, ...rel.split('/')))
	for (let directory = rel.split('/').slice(0, -1).join('/'); directory.startsWith(`${stopAt}/`); directory = directory.split('/').slice(0, -1).join('/')) {
		const path = join(realProject, ...directory.split('/'))
		if ((await readdir(path).catch(() => ['?'])).length > 0) break
		await rmdir(path).catch(() => undefined)
	}
}

async function readCopyRecord(realProject: string): Promise<CopyRecord | undefined> {
	const state = await inspectProjectPath(realProject, COPY_RECORD_FILENAME)
	if (state === 'absent') return undefined
	if (state !== 'file') throw new Refusal(`${COPY_RECORD_FILENAME} in ${realProject} is not a regular file.`)
	let input: unknown
	try {
		input = JSON.parse(await readFile(join(realProject, COPY_RECORD_FILENAME), 'utf8'))
	}
	catch {
		throw new Refusal(`${COPY_RECORD_FILENAME} in ${realProject} could not be read as JSON.`)
	}
	const validation = validateCopyRecord(input)
	if (!validation.ok)
		throw new Refusal([`${COPY_RECORD_FILENAME} in ${realProject} is invalid:`, ...validation.diagnostics.map(d => `  ${d.path || '/'}: ${d.message}`)].join('\n'))
	return validation.value
}

/** Writes the copy record through a temporary file in the project root, renamed over it. */
async function writeCopyRecord(realProject: string, record: CopyRecord): Promise<void> {
	const temporary = `.${COPY_RECORD_FILENAME}.${process.pid}.tmp`
	await writeProjectFile(realProject, temporary, Buffer.from(serializeCopyRecord(record), 'utf8'))
	try {
		await rename(join(realProject, temporary), join(realProject, COPY_RECORD_FILENAME))
	}
	catch (error) {
		await rm(join(realProject, temporary), { force: true })
		throw error
	}
}

// ---------------------------------------------------------------------------------------------
// list

async function listCommand(parsed: ParsedArguments, context: Context): Promise<number> {
	const { kit } = await loadProductKit(stringOption(parsed, 'workspace'), context)
	const names = Object.keys(kit.components).sort()
	if (names.length === 0) {
		context.out('The Product Kit registry has no components.')
		return 0
	}
	for (const name of names) {
		const component = kit.components[name]!
		const details = [
			component.layer,
			`${component.files.length} file${component.files.length === 1 ? '' : 's'}`,
			...(component.requires?.length ? [`requires ${component.requires.join(', ')}`] : []),
			...(component.packages?.length ? [`packages ${component.packages.join(', ')}`] : []),
		]
		context.out(`${name}  ${details.join('; ')}`)
	}
	return 0
}

// ---------------------------------------------------------------------------------------------
// add

type PlannedFile = { component: string; source: string; destination: string; bytes: Uint8Array; digest: string }

async function addCommand(parsed: ParsedArguments, context: Context): Promise<number> {
	const names = [...new Set(parsed.positionals)]
	const to = stringOption(parsed, 'to')
	if (names.length === 0 || to === undefined)
		throw new Refusal(`components add needs at least one component name and --to <dir>.\n  ${USAGE[1]}`, 2)
	const force = parsed.values.force === true
	const workspace = await loadProductKit(stringOption(parsed, 'workspace'), context)
	const { kit } = workspace

	const closure = componentClosure(kit, names)
	if (!closure.ok)
		throw new Refusal(`The Product Kit registry has no component ${closure.unknown.join(', ')}. uiux components list shows the registry.`)

	const toPath = resolve(context.cwd, to)
	const { chosen: chosenProject, real: realProject } = await selectProductProject(stringOption(parsed, 'project'), toPath, context, workspace)
	const realTo = realFuturePath(toPath)
	// The target as written below the project, so a link on the way is seen and refused; the real
	// paths only when --to and the project are spelled through different links.
	const target = projectRelative(chosenProject, toPath) ?? projectRelative(realProject, realTo)
	if (target === undefined)
		throw new Refusal(`--to ${to} must name a directory strictly inside the product project ${realProject}.`, 2)
	if (isSameOrInside(workspace.realRoot, realTo))
		throw new Refusal(`--to ${to} lies inside the Workspace ${workspace.realRoot}; components are copied out of it, never into it.`, 2)
	const targetState = await inspectProjectPath(realProject, target)
	if (targetState !== 'absent' && targetState !== 'directory')
		throw new Refusal(`--to ${to} is not a directory.`, 2)

	const record = await readCopyRecord(realProject) ?? emptyCopyRecord()
	const inClosure = new Set(closure.components)
	const refusals: string[] = []

	// Rules 01a11bb1-a4a6-… and 01a11be8-5931-…: a component recorded at another target directory
	// refuses the copy, naming that target, unless forced; forced, it moves to this target.
	const moved = new Map<string, string>()
	for (const name of closure.components) {
		const recorded = record.components[name]
		if (recorded === undefined || recorded.target === target) continue
		if (force) moved.set(name, recorded.target)
		else refusals.push(`${name}${names.includes(name) ? '' : ` (required by ${requiredBy(kit, name, inClosure).join(', ')})`} is already copied to ${recorded.target}; run the command with --to ${recorded.target}, or with --force to move it to ${target}.`)
	}
	// Rule 01a11c09-d0d9-…: no recorded component outside this copy may be left requiring one that
	// ends up at another target directory, since its relative imports would no longer resolve.
	for (const [name, recorded] of Object.entries(record.components)) {
		if (inClosure.has(name) || recorded.target === target) continue
		const stranded = closure.components.filter(required => kit.components[name]?.requires?.includes(required))
		if (stranded.length > 0)
			refusals.push(`${name}, copied to ${recorded.target}, requires ${stranded.join(', ')}, which this copy places in ${target}; add ${name} to the command to keep its imports resolving.`)
	}

	// The files to write: each component's files, at their path relative to kit/src/ under the target (Rule 01a11bb1-a376-…).
	const planned = new Map<string, PlannedFile>()
	const entries = new Map<string, Omit<CopyRecordEntry, 'exportedAt'>>()
	for (const name of closure.components) {
		const files: Record<string, string> = {}
		const recordFiles: CopyRecordEntry['files'] = {}
		for (const source of kit.components[name]!.files) {
			const bytes = await readKitSourceFile(workspace.project, source)
			if (bytes === undefined) {
				refusals.push(`${name} declares kit/${source}, which is not a regular file under kit/src/ reached without a symbolic link.`)
				continue
			}
			const digest = await fileDigest(bytes)
			const destination = copyDestination(target, source)
			files[source] = digest
			recordFiles[destination] = { source, digest }
			planned.set(destination, { component: name, source, destination, bytes, digest })
		}
		entries.set(name, { target, componentDigest: await componentDigest(files), files: recordFiles })
	}

	// Files recorded for components outside this copy: never overwritten with other content.
	const recordedElsewhere = new Map<string, Readonly<{ component: string; digest: string }>>()
	for (const [name, recorded] of Object.entries(record.components)) {
		if (inClosure.has(name)) continue
		for (const [file, { digest }] of Object.entries(recorded.files)) recordedElsewhere.set(file, { component: name, digest })
	}
	const recordedDigest = (file: string): string | undefined => {
		for (const name of closure.components) {
			const digest = record.components[name]?.files[file]?.digest
			if (digest !== undefined) return digest
		}
		return undefined
	}

	// Rule 01a11bb1-a444-…: a copied file that differs from its recorded digest is overwritten or
	// removed only when forced; so is a file the record does not list.
	const writes: PlannedFile[] = []
	let unchanged = 0
	for (const file of [...planned.values()].sort((a, b) => a.destination.localeCompare(b.destination))) {
		const other = recordedElsewhere.get(file.destination)
		if (other && other.digest !== file.digest) {
			refusals.push(`${file.destination} is also the copy of a file of ${other.component}, which this copy would change; add ${other.component} to the command.`)
			continue
		}
		const state = await inspectProjectPath(realProject, file.destination)
		if (state === 'absent') {
			writes.push(file)
			continue
		}
		if (state !== 'file') {
			refusals.push(`${file.destination} exists in the product project and is not a regular file.`)
			continue
		}
		const current = await fileDigest((await readProjectFile(realProject, file.destination))!)
		if (current === file.digest) {
			unchanged++
			continue
		}
		const recorded = recordedDigest(file.destination)
		if (!force && recorded === undefined)
			refusals.push(`${file.destination} already exists and is not a recorded copy; --force overwrites it.`)
		else if (!force && current !== recorded)
			refusals.push(`${file.destination} was changed since it was copied (it differs from its recorded digest); --force overwrites it.`)
		writes.push(file)
	}

	// Recorded files of these components that this copy no longer writes: the files of a moved
	// component at its former target, and files its component no longer declares.
	const removals: Array<Readonly<{ file: string; target: string }>> = []
	for (const name of closure.components) {
		const recorded = record.components[name]
		if (recorded === undefined) continue
		for (const [file, { digest }] of Object.entries(recorded.files)) {
			if (planned.has(file) || recordedElsewhere.has(file)) continue
			const state = await inspectProjectPath(realProject, file)
			if (state !== 'file') continue
			if (!force && await fileDigest((await readProjectFile(realProject, file))!) !== digest)
				refusals.push(`${file} was changed since it was copied, and this copy would remove it; --force removes it.`)
			removals.push({ file, target: recorded.target })
		}
	}

	let ranges: ReadonlyMap<string, string> = new Map()
	const packages = componentPackages(kit, closure.components)
	if (packages.length > 0 && workspace.project.directory) {
		try {
			ranges = await readKitDependencyRanges(workspace.project.directory)
		}
		catch (error) {
			refusals.push(error instanceof Error ? error.message : String(error))
		}
	}

	if (refusals.length > 0)
		throw new Refusal([...refusals, 'Nothing was written.'].join('\n'))

	// Apply: the target files, the removals, then the record (Rule 01a11bb1-a50a-…: nothing else).
	for (const file of writes) await writeProjectFile(realProject, file.destination, file.bytes)
	for (const removal of removals) await removeProjectFile(realProject, removal.file, removal.target)
	const exportedAt = context.now().toISOString()
	const next: CopyRecord = { formatVersion: record.formatVersion, components: { ...record.components } }
	for (const [name, entry] of entries) {
		const previous = record.components[name]
		const same = previous !== undefined && previous.target === entry.target && previous.componentDigest === entry.componentDigest
			&& serializeFiles(previous.files) === serializeFiles(entry.files)
		next.components[name] = same ? previous : { ...entry, exportedAt }
	}
	if (serializeCopyRecord(next) !== serializeCopyRecord(record) || (await inspectProjectPath(realProject, COPY_RECORD_FILENAME)) === 'absent')
		await writeCopyRecord(realProject, next)

	context.out(`Copied ${closure.components.join(', ')} to ${target} (${writes.length} file${writes.length === 1 ? '' : 's'} written, ${unchanged} unchanged); recorded in ${COPY_RECORD_FILENAME}.`)
	for (const [name, from] of moved) context.out(`Moved ${name} from ${from} to ${target}.`)
	if (packages.length > 0) {
		context.out('The copied components need these packages in the product project:')
		for (const name of packages) {
			const range = ranges.get(name)
			context.out(range === undefined ? `  ${name} (kit/package.json declares no version range)` : `  ${name}@${range}`)
		}
	}
	return 0
}

function requiredBy(kit: ProductKit, name: string, inClosure: ReadonlySet<string>): string[] {
	return componentsRequiring(kit, name).filter(dependent => inClosure.has(dependent))
}

function serializeFiles(files: CopyRecordEntry['files']): string {
	return JSON.stringify(Object.keys(files).sort().map(key => [key, files[key]!.source, files[key]!.digest]))
}

// ---------------------------------------------------------------------------------------------
// diff

async function diffCommand(parsed: ParsedArguments, context: Context): Promise<number> {
	const workspace = await loadProductKit(stringOption(parsed, 'workspace'), context)
	const { real: realProject } = await selectProductProject(stringOption(parsed, 'project'), context.cwd, context, workspace)
	const record = await readCopyRecord(realProject)
	if (record === undefined || Object.keys(record.components).length === 0) {
		context.out(`No components are recorded in ${join(realProject, COPY_RECORD_FILENAME)}.`)
		return 0
	}
	// Rule 01a11bb1-a630-…: each recorded file's digest against its copy and its Workspace original.
	const counts = new Map<DriftState, number>(DRIFT_STATES.map(state => [state, 0]))
	for (const name of Object.keys(record.components).sort()) {
		const entry = record.components[name]!
		const component = workspace.kit.components[name]
		for (const file of Object.keys(entry.files).sort()) {
			const { source, digest } = entry.files[file]!
			const copyBytes = await readProjectFile(realProject, file)
			let original: string | undefined | 'removed' = 'removed'
			if (component !== undefined) {
				const bytes = component.files.includes(source) ? await readKitSourceFile(workspace.project, source) : undefined
				original = bytes === undefined ? undefined : await fileDigest(bytes)
			}
			const state = driftState({ recorded: digest, copy: copyBytes === undefined ? undefined : await fileDigest(copyBytes), original })
			counts.set(state, counts.get(state)! + 1)
			context.out(`${state.padEnd(9)} ${file} (${name})`)
		}
	}
	const drifted = [...counts].filter(([state, count]) => state !== 'unchanged' && count > 0)
	context.out(drifted.length === 0 ? 'Every recorded file is unchanged.' : `Drift: ${drifted.map(([state, count]) => `${count} ${state}`).join(', ')}.`)
	return parsed.values.check === true && drifted.length > 0 ? 1 : 0
}

/** The Git toplevel of `directory`, or `undefined` outside a Git repository or without Git. */
function gitToplevel(directory: string): string | undefined {
	const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
	const toplevel = result.status === 0 ? result.stdout.trim() : ''
	return toplevel === '' ? undefined : resolve(toplevel)
}
