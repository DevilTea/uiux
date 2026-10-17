import { spawnSync } from 'node:child_process'
import { constants, lstatSync, realpathSync, type Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { NO_FOLLOW, openedFilePath, PATH_BINDING } from '../adapters/bound-open'
import { readKitDependencyRanges } from '../adapters/kit-dependencies'
import { locateKitProject, type KitProject } from '../adapters/kit-registry'
import { readKitSourceFile, type KitFileReadOptions } from '../adapters/kit-source-files'
import { componentClosure, componentPackages, componentsRequiring } from '../domain/product-kit/closure'
import {
	caseOnlyCollisions,
	COPY_RECORD_FILENAME,
	copyDestination,
	driftState,
	DRIFT_STATES,
	emptyCopyRecord,
	hasGitSegment,
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

/** The CLI reads kit source files of any size: the 8 MiB limit is the MCP and Workbench reads' (Clause 01a13d3e-c4b5-…). */
const KIT_READ: KitFileReadOptions = { maxBytes: Number.POSITIVE_INFINITY }

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
 * reached without a symbolic link, judged again on the open file (`readKitSourceFile`). In the product project, no path between the
 * project root and a file it reads or writes may be a symbolic link, every target and copied file,
 * whether `--to` names it or the copy record does, lies strictly inside the project, outside the
 * Workspace and outside any `.git` directory, and the project itself lies outside the Workspace.
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

/**
 * Why `uiux components` may not write or remove at the project-relative path `rel`, or `undefined`
 * when it may: it must be a plain relative path with no `.git` segment whose real path lies strictly
 * inside the project and outside the Workspace. Every target and copied file passes this check,
 * whether `--to` names it or the copy record does. A path through a symbolic link is left to
 * `inspectProjectPath`, which refuses it, naming the link, before anything is read or written.
 */
function projectPathProblem(realProject: string, realWorkspace: string, rel: string): string | undefined {
	if (!isSafeRelativePath(rel)) return 'is not a plain relative path'
	if (hasGitSegment(rel)) return 'lies in a .git directory'
	// The real path, segment by segment: the existing ones in their on-disk spelling (a
	// case-insensitive file system answers to any letter case), the rest as written.
	const segments = rel.split('/')
	let real = realProject
	for (const [index, segment] of segments.entries()) {
		const next = join(real, segment)
		let info: Stats | undefined
		try {
			info = lstatSync(next, { throwIfNoEntry: false })
		}
		catch {
			info = undefined // Below a file (ENOTDIR): `inspectProjectPath` refuses it.
		}
		if (info?.isSymbolicLink()) return undefined
		if (!info) {
			real = join(next, ...segments.slice(index + 1))
			break
		}
		real = realpathSync.native(next)
	}
	if (relative(realProject, real) === '' || !isSameOrInside(realProject, real)) return 'does not lie strictly inside the product project'
	if (isSameOrInside(realWorkspace, real)) return `lies inside the Workspace ${realWorkspace}`
	return undefined
}

/**
 * Each target or file in the copy record that fails `projectPathProblem`. Any one refuses the whole
 * command before it reads or writes a copy: the record lies in the product project, and anyone who
 * can edit it there could otherwise steer `add` into the Workspace or `.git`.
 */
function recordedPathProblems(realProject: string, realWorkspace: string, record: CopyRecord): string[] {
	const problems: string[] = []
	for (const [name, entry] of Object.entries(record.components)) {
		for (const path of [entry.target, ...Object.keys(entry.files)]) {
			const problem = projectPathProblem(realProject, realWorkspace, path)
			if (problem !== undefined) problems.push(`${COPY_RECORD_FILENAME} records ${path} for ${name}, which ${problem}; correct or remove that entry.`)
		}
	}
	return problems
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

/** Refuses unless every directory between the project root and the file `rel` is a directory reached without a symbolic link. */
async function assertDirectoriesWithoutLinks(realProject: string, segments: readonly string[]): Promise<void> {
	let path = realProject
	for (const [index, segment] of segments.slice(0, -1).entries()) {
		path = join(path, segment)
		const info = await lstat(path)
		if (info.isSymbolicLink() || !info.isDirectory())
			throw new Refusal(`${segments.slice(0, index + 1).join('/')} in the product project is not a directory reached without a symbolic link.`)
	}
}

/**
 * Writes the project file `rel`, creating its directories one at a time and checking each before
 * descending into it. The file is opened without following a link ({@link NO_FOLLOW}) and without
 * truncating it; only when the path, walked again without links, still reaches the file opened, and
 * on linux `/proc/self/fd` places the open file inside the product project, is it truncated and
 * written. When the write fails after the truncation (a full disk, say), the partly written file is
 * removed again ({@link unlinkProjectFile}, bound to the file opened), so a rerun of the command
 * finds the path absent and converges; a {@link PartialWrite} says whether that removal succeeded.
 *
 * Residual risk: Node offers no `openat` or `O_BENEATH`. On darwin the open refuses a link in any
 * component, so nothing is created through one. Elsewhere a local user who can write in the product
 * project and swaps a checked directory for a symbolic link between the walk and the open can make
 * `O_CREAT` leave an empty file where that link points; the checks after the open refuse to write
 * into it (on linux bound to the open file, elsewhere by path only), and the window is a few system
 * calls wide (issue #206).
 */
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
	const leaf = join(path, segments.at(-1)!)
	const handle = await open(leaf, constants.O_WRONLY | constants.O_CREAT | NO_FOLLOW, 0o666).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ELOOP') throw new Refusal(`${rel} in the product project is not a file reached without a symbolic link.`)
		throw error
	})
	try {
		const opened = await handle.stat()
		await assertDirectoriesWithoutLinks(realProject, segments)
		const current = await lstat(leaf)
		const where = PATH_BINDING === 'fd' ? await openedFilePath(handle) : leaf
		if (!opened.isFile() || current.dev !== opened.dev || current.ino !== opened.ino || where === undefined || where === realProject || !isSameOrInside(realProject, where))
			throw new Refusal(`${rel} in the product project changed while it was being written.`)
		await handle.truncate(0)
		try {
			await handle.writeFile(bytes)
		}
		catch (error) {
			const removed = await unlinkProjectFile(realProject, segments, opened).then(() => true, () => false)
			throw new PartialWrite(rel, removed, error)
		}
	}
	finally {
		await handle.close()
	}
}

/** A project file write that failed after its file was truncated; `removed` tells whether the partly written file was removed again. */
class PartialWrite extends Error {
	constructor(readonly file: string, readonly removed: boolean, cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause })
		this.name = 'PartialWrite'
	}
}

/**
 * Unlinks the project file at `segments` when it is still the regular file `expected` (by `dev` and
 * `ino`). Its directory is opened without following a link ({@link NO_FOLLOW}) and must still be the
 * directory its path, walked again without links, reaches; on linux `/proc/self/fd` must place it
 * inside the product project, and the file is then named and unlinked through that open directory,
 * so the unlink happens in the directory checked whatever its path leads to by then.
 *
 * Residual risk, as for {@link writeProjectFile}: Node offers no `unlinkat`. On darwin (`/dev/fd`
 * cannot be walked into) and elsewhere the unlink goes by path after these checks, so a local user
 * who can write in the product project and swaps a checked directory for a symbolic link in the few
 * system calls between the last check and the unlink can make it remove a same-named file where that
 * link points, outside the copy (issue #206). On linux that window is closed; a swap of the file
 * itself within the checked directory can only make it remove that entry, which unlink never follows.
 */
async function unlinkProjectFile(realProject: string, segments: readonly string[], expected: Readonly<{ dev: number; ino: number }>): Promise<void> {
	const rel = segments.join('/')
	const changed = () => new Refusal(`${rel} in the product project changed while it was being removed.`)
	const parent = join(realProject, ...segments.slice(0, -1))
	const name = segments.at(-1)!
	const check = async (leaf: string) => {
		const info = await lstat(leaf)
		if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino) throw changed()
	}
	if (PATH_BINDING === 'none') {
		await assertDirectoriesWithoutLinks(realProject, segments)
		await check(join(parent, name))
		await unlink(join(parent, name))
		return
	}
	const directory = await open(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NO_FOLLOW)
	try {
		const opened = await directory.stat()
		await assertDirectoriesWithoutLinks(realProject, segments)
		const current = await lstat(parent)
		const where = PATH_BINDING === 'fd' ? await openedFilePath(directory) : parent
		if (!opened.isDirectory() || current.dev !== opened.dev || current.ino !== opened.ino || where === undefined || !isSameOrInside(realProject, where))
			throw changed()
		const leaf = PATH_BINDING === 'fd' ? `/proc/self/fd/${directory.fd}/${name}` : join(parent, name)
		await check(leaf)
		await unlink(leaf)
	}
	finally {
		await directory.close()
	}
}

/** The `dev:ino` identity of a file, to recognise one file reached by two spellings of its path. */
function fileIdentity(info: Readonly<{ dev: number; ino: number }>): string {
	return `${info.dev}:${info.ino}`
}

/**
 * Removes the project file `rel`, then the directories it leaves empty, strictly below `stopAt`.
 * A file whose identity is in `keep` (a file this command just wrote or left in place) is never
 * removed, so two spellings of one path on a case-insensitive file system cannot lose it. Returns
 * whether the file was removed. The file is unlinked by {@link unlinkProjectFile}, whose residual
 * risk applies; the empty directories are removed by path, so the same swap can at worst remove an
 * empty directory where a link points (`rmdir` removes nothing else).
 */
async function removeProjectFile(realProject: string, rel: string, stopAt: string, keep: ReadonlySet<string>): Promise<boolean> {
	if (await inspectProjectPath(realProject, rel) !== 'file') return false
	const info = await lstat(join(realProject, ...rel.split('/')))
	if (keep.has(fileIdentity(info))) return false
	await unlinkProjectFile(realProject, rel.split('/'), info)
	for (let directory = rel.split('/').slice(0, -1).join('/'); directory.startsWith(`${stopAt}/`); directory = directory.split('/').slice(0, -1).join('/')) {
		const directoryPath = join(realProject, ...directory.split('/'))
		if ((await readdir(directoryPath).catch(() => ['?'])).length > 0) break
		await rmdir(directoryPath).catch(() => undefined)
	}
	return true
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

	if (to.includes('\\'))
		throw new Refusal(`--to ${to} contains a backslash; separate its directories with /.`, 2)
	const toPath = resolve(context.cwd, to)
	const { chosen: chosenProject, real: realProject } = await selectProductProject(stringOption(parsed, 'project'), toPath, context, workspace)
	const realTo = realFuturePath(toPath)
	// The target as written below the project, so a link on the way is seen and refused; the real
	// paths only when --to and the project are spelled through different links. Clause
	// 01a11bb1-9c51-…: strictly inside the project, never its root.
	const target = projectRelative(chosenProject, toPath) ?? projectRelative(realProject, realTo)
	if (target === undefined)
		throw new Refusal(`--to ${to} must name a directory strictly inside the product project ${realProject}, not the project root.`, 2)
	if (isSameOrInside(workspace.realRoot, realTo))
		throw new Refusal(`--to ${to} lies inside the Workspace ${workspace.realRoot}; components are copied out of it, never into it.`, 2)
	const targetProblem = projectPathProblem(realProject, workspace.realRoot, target)
	if (targetProblem !== undefined)
		throw new Refusal(`--to ${to} ${targetProblem}.`, 2)
	const targetState = await inspectProjectPath(realProject, target)
	if (targetState !== 'absent' && targetState !== 'directory')
		throw new Refusal(`--to ${to} is not a directory.`, 2)

	const record = await readCopyRecord(realProject) ?? emptyCopyRecord()
	const recordProblems = recordedPathProblems(realProject, workspace.realRoot, record)
	if (recordProblems.length > 0) throw new Refusal([...recordProblems, 'Nothing was written.'].join('\n'))
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
	// Rules 01a11c09-d0d9-… and 01a11be8-5931-…: no recorded component outside this copy may be left
	// requiring one that ends up at another target directory, since its relative imports would no
	// longer resolve; --force does not lift this, and naming the dependent moves it too.
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
			const read = await readKitSourceFile(workspace.project, source, KIT_READ)
			if (read.status !== 'found') {
				refusals.push(read.status === 'too_large'
					? `${name} declares kit/${source}, which is too large to read.`
					: `${name} declares kit/${source}, which is not a regular file under kit/src/ reached without a symbolic link.`)
				continue
			}
			const bytes = read.bytes
			const digest = await fileDigest(bytes)
			const destination = copyDestination(target, source)
			const problem = projectPathProblem(realProject, workspace.realRoot, destination)
			if (problem !== undefined) {
				refusals.push(`${name} would copy kit/${source} to ${destination}, which ${problem}.`)
				continue
			}
			// Clause 01a11bb1-8b0c-…: the component digest keys each file by its kit-relative source path.
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
	// removed only when forced; so is a file the record does not list (Rule 01a13a68-5ea6-…).
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
	// component at its former target. Only a file recorded for the component whose source the
	// registry still declares for it is removed; a file the component no longer declares stays in
	// place, unrecorded, and is named in the output.
	const removals: Array<Readonly<{ file: string; target: string }>> = []
	const leftInPlace = new Map<string, string>()
	for (const name of closure.components) {
		const recorded = record.components[name]
		if (recorded === undefined) continue
		const declared = new Set(kit.components[name]!.files)
		for (const [file, { source, digest }] of Object.entries(recorded.files)) {
			if (planned.has(file) || recordedElsewhere.has(file)) continue
			const state = await inspectProjectPath(realProject, file)
			if (state !== 'file') continue
			if (!declared.has(source)) {
				leftInPlace.set(file, `Left ${file} in place: ${name} no longer declares kit/${source}, so it is no longer recorded.`)
				continue
			}
			if (!force && await fileDigest((await readProjectFile(realProject, file))!) !== digest)
				refusals.push(`${file} was changed since it was copied, and this copy would remove it; --force removes it.`)
			removals.push({ file, target: recorded.target })
		}
	}

	// Two paths that differ only in letter case are one file on a case-insensitive file system: a
	// write would land on a file this copy removes, leaves in place or another component's copy, and
	// a removal on a file it just wrote. Refused everywhere, so a project stays portable between
	// file systems; the identity check in `removeProjectFile` backs this up.
	const removalFiles = new Set(removals.map(removal => removal.file))
	for (const [first, second] of caseOnlyCollisions([...planned.keys(), ...removalFiles, ...leftInPlace.keys(), ...recordedElsewhere.keys()])) {
		if (!planned.has(first) && !planned.has(second) && !removalFiles.has(first) && !removalFiles.has(second)) continue
		refusals.push(`${first} and ${second} differ only in letter case, which a case-insensitive file system treats as one file; rename or remove ${planned.has(first) ? second : first}${moved.size > 0 ? ', or run the command with --to set to the recorded target' : ''}.`)
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

	const exportedAt = context.now().toISOString()
	const next: CopyRecord = { formatVersion: record.formatVersion, components: { ...record.components } }
	for (const [name, entry] of entries) {
		const previous = record.components[name]
		const same = previous !== undefined && previous.target === entry.target && previous.componentDigest === entry.componentDigest
			&& serializeFiles(previous.files) === serializeFiles(entry.files)
		next.components[name] = same ? previous : { ...entry, exportedAt }
	}

	// Apply (Rule 01a11bb1-a50a-…: nothing else is written): the new files, then the removals, then
	// the record, renamed into place. Until the record is replaced it still describes the former
	// copy, so after a failure at any step the same command finds the files already written
	// unchanged, removes what is left at a former target and records the copy: a rerun converges.
	// Writing the record before the removals would instead leave unrecorded leftovers that no rerun
	// removes, a component copied twice (Rule 01a11be8-59a6-…).
	const written: string[] = []
	const removed: string[] = []
	try {
		for (const file of writes) {
			await writeProjectFile(realProject, file.destination, file.bytes)
			written.push(file.destination)
		}
		const keep = new Set<string>()
		for (const destination of planned.keys()) keep.add(fileIdentity(await lstat(join(realProject, ...destination.split('/')))))
		for (const removal of removals) {
			if (await removeProjectFile(realProject, removal.file, removal.target, keep)) removed.push(removal.file)
		}
		if (serializeCopyRecord(next) !== serializeCopyRecord(record) || (await inspectProjectPath(realProject, COPY_RECORD_FILENAME)) === 'absent')
			await writeCopyRecord(realProject, next)
	}
	catch (error) {
		// A file left partly written would make the rerun refuse it as an unrecorded file, so it is
		// removed again; when that fails too, it is named, with how to finish anyway (issue #206).
		const partial = error instanceof PartialWrite
			? [error.removed
					? `${error.file} was only partly written and was removed again.`
					: `${error.file} was only partly written and could not be removed; remove it, or add --force to the same command.`]
			: []
		throw new Refusal([
			`Copying stopped: ${error instanceof Error ? error.message : String(error)}`,
			written.length > 0 ? `Written: ${written.join(', ')}.` : 'No file was written.',
			...partial,
			...(removed.length > 0 ? [`Removed: ${removed.join(', ')}.`] : []),
			`${COPY_RECORD_FILENAME} was not changed. Fix the cause and run the same command again to finish the copy.`,
		].join('\n'))
	}

	context.out(`Copied ${closure.components.join(', ')} to ${target} (${writes.length} file${writes.length === 1 ? '' : 's'} written, ${unchanged} unchanged); recorded in ${COPY_RECORD_FILENAME}.`)
	for (const [name, from] of moved) context.out(`Moved ${name} from ${from} to ${target}.`)
	for (const line of leftInPlace.values()) context.out(line)
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
	const recordProblems = recordedPathProblems(realProject, workspace.realRoot, record)
	if (recordProblems.length > 0) throw new Refusal(recordProblems.join('\n'))
	// Rule 01a11bb1-a630-…: each recorded file's digest against its copy and its Workspace original.
	// A copy reached through a symbolic link has no drift state of Clause 01a11bb1-8c9b-…, so it
	// refuses the whole report, naming the link; the report is printed only once every file has one.
	const lines: string[] = []
	const counts = new Map<DriftState, number>(DRIFT_STATES.map(state => [state, 0]))
	for (const name of Object.keys(record.components).sort()) {
		const entry = record.components[name]!
		const component = workspace.kit.components[name]
		for (const file of Object.keys(entry.files).sort()) {
			const { source, digest } = entry.files[file]!
			const copyBytes = await readProjectFile(realProject, file)
			let original: string | undefined | 'removed' = 'removed'
			if (component !== undefined) {
				const read = component.files.includes(source) ? await readKitSourceFile(workspace.project, source, KIT_READ) : undefined
				original = read?.status === 'found' ? await fileDigest(read.bytes) : undefined
			}
			const state = driftState({ recorded: digest, copy: copyBytes === undefined ? undefined : await fileDigest(copyBytes), original })
			counts.set(state, counts.get(state)! + 1)
			lines.push(`${state.padEnd(9)} ${file} (${name})`)
		}
	}
	for (const line of lines) context.out(line)
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
