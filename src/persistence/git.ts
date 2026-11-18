import { spawn, spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Running `git` (Discussion #491 P1: Git is required, and whatever Git can do, UIUX does not
 * build). Every call is a fixed argument list with no shell, run in the directory `cwd` through `-C`,
 * with the environment variables that could point Git at another repository removed,
 * `GIT_OPTIONAL_LOCKS=0` so a read never refreshes the index, `core.fsmonitor` off so no daemon
 * starts, and a timeout. This module only reads: no caller passes a command that writes.
 */

/** How long one `git` call may run before it is stopped. */
export const GIT_TIMEOUT_MS = 10_000
/** The most bytes one `git` call may print. */
export const GIT_MAX_OUTPUT_BYTES = 256 * 1024 * 1024

/** Variables that select a repository or an index other than the one `-C` names. */
const REPOSITORY_VARIABLES = [
	'GIT_DIR',
	'GIT_WORK_TREE',
	'GIT_INDEX_FILE',
	'GIT_OBJECT_DIRECTORY',
	'GIT_ALTERNATE_OBJECT_DIRECTORIES',
	'GIT_COMMON_DIR',
	'GIT_PREFIX',
	'GIT_NAMESPACE',
	'GIT_QUARANTINE_PATH',
] as const

export type GitFailure = Readonly<{
	ok: false
	/** `missing`: `git` cannot be run; `timeout`; `too_large`; `failed`: a non-zero exit. */
	reason: 'missing' | 'timeout' | 'too_large' | 'failed'
	message: string
	exitCode?: number
}>
export type GitSuccess = Readonly<{ ok: true; stdout: Buffer }>
export type GitResult = GitSuccess | GitFailure

export type GitRunOptions = Readonly<{
	timeoutMs?: number
	maxBytes?: number
	/** Bytes written to standard input (a `cat-file --batch` request list). */
	input?: string
}>

export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
	for (const name of REPOSITORY_VARIABLES) delete next[name]
	return next
}

function gitArguments(cwd: string, args: readonly string[]): string[] {
	return ['-C', cwd, '-c', 'core.fsmonitor=false', ...args]
}

function describeFailure(args: readonly string[], stderr: string, detail: string): string {
	const text = stderr.trim().split('\n')[0]?.trim()
	return `git ${args[0] ?? ''} ${text ? `failed: ${text}` : detail}`.trim()
}

/** Runs `git -C <cwd> <args>` and waits for it. Never throws. */
export function runGit(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<GitResult> {
	const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
	const maxBytes = options.maxBytes ?? GIT_MAX_OUTPUT_BYTES
	return new Promise((resolveResult) => {
		let child: ReturnType<typeof spawn>
		try {
			child = spawn('git', gitArguments(cwd, args), { env: gitEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
		}
		catch (error) {
			resolveResult({ ok: false, reason: 'missing', message: `git cannot be run: ${error instanceof Error ? error.message : String(error)}` })
			return
		}
		const chunks: Buffer[] = []
		let size = 0
		let stderr = ''
		let settled = false
		const finish = (result: GitResult): void => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolveResult(result)
		}
		const stop = (result: GitFailure): void => {
			child.kill('SIGKILL')
			finish(result)
		}
		const timer = setTimeout(() => stop({ ok: false, reason: 'timeout', message: `git ${args[0] ?? ''} did not finish within ${timeoutMs} ms` }), timeoutMs)
		child.stdout!.on('data', (chunk: Buffer) => {
			size += chunk.length
			if (size > maxBytes) stop({ ok: false, reason: 'too_large', message: `git ${args[0] ?? ''} printed more than ${maxBytes} bytes` })
			else chunks.push(chunk)
		})
		child.stderr!.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8') })
		child.on('error', (error: NodeJS.ErrnoException) => {
			finish({ ok: false, reason: error.code === 'ENOENT' ? 'missing' : 'failed', message: error.code === 'ENOENT' ? 'git cannot be run: it is not installed or not on PATH' : `git cannot be run: ${error.message}` })
		})
		child.on('close', (code) => {
			if (code === 0) finish({ ok: true, stdout: Buffer.concat(chunks) })
			else finish({ ok: false, reason: 'failed', exitCode: code ?? -1, message: describeFailure(args, stderr, `exited with status ${code}`) })
		})
		child.stdin!.on('error', () => undefined)
		child.stdin!.end(options.input ?? '')
	})
}

/** Runs `git -C <cwd> <args>` and waits for it, for callers that cannot await (the CLI entry checks). Never throws. */
export function runGitSync(cwd: string, args: readonly string[], options: GitRunOptions = {}): GitResult {
	const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS
	const result = spawnSync('git', gitArguments(cwd, args), {
		env: gitEnvironment(),
		timeout: timeoutMs,
		maxBuffer: options.maxBytes ?? GIT_MAX_OUTPUT_BYTES,
		input: options.input ?? '',
		windowsHide: true,
		shell: false,
	})
	if (result.error) {
		const code = (result.error as NodeJS.ErrnoException).code
		if (code === 'ENOENT') return { ok: false, reason: 'missing', message: 'git cannot be run: it is not installed or not on PATH' }
		if (code === 'ETIMEDOUT') return { ok: false, reason: 'timeout', message: `git ${args[0] ?? ''} did not finish within ${timeoutMs} ms` }
		if (code === 'ENOBUFS') return { ok: false, reason: 'too_large', message: `git ${args[0] ?? ''} printed too much` }
		return { ok: false, reason: 'missing', message: `git cannot be run: ${result.error.message}` }
	}
	if (result.status === 0) return { ok: true, stdout: result.stdout }
	return { ok: false, reason: 'failed', exitCode: result.status ?? -1, message: describeFailure(args, result.stderr?.toString('utf8') ?? '', `exited with status ${result.status}`) }
}

/** The nearest existing directory of `path`: itself, or its closest ancestor (a Workspace root that does not exist yet). */
export function nearestExistingDirectory(path: string): string {
	let current = resolve(path)
	for (;;) {
		try {
			if (statSync(current).isDirectory()) return current
		}
		catch { /* missing or not readable: look one level up */ }
		const parent = dirname(current)
		if (parent === current) return current
		current = parent
	}
}

export type GitWorkTreeCheck =
	| Readonly<{ ok: true; toplevel: string }>
	| Readonly<{ ok: false; message: string }>

/**
 * Clause 01a1ece9-97ec-736f-99a3-80b76efc800b: whether `root`, or its nearest existing ancestor
 * when it does not exist yet, is inside a Git work tree. Not inside one, and `git` that cannot be
 * run to tell, are both a refusal; the message says which.
 */
export function checkGitWorkTree(root: string): GitWorkTreeCheck {
	const directory = nearestExistingDirectory(root)
	const inside = runGitSync(directory, ['rev-parse', '--is-inside-work-tree'])
	if (!inside.ok) {
		return inside.reason === 'failed'
			? { ok: false, message: `${root} is not inside a Git work tree (git said: ${inside.message}).` }
			: { ok: false, message: `${inside.message}, so UIUX cannot tell whether ${root} is inside a Git work tree.` }
	}
	if (inside.stdout.toString('utf8').trim() !== 'true') return { ok: false, message: `${root} is not inside a Git work tree.` }
	const top = runGitSync(directory, ['rev-parse', '--show-toplevel'])
	if (!top.ok) return { ok: false, message: `${top.message}, so UIUX cannot tell where the Git work tree of ${root} is.` }
	return { ok: true, toplevel: resolve(top.stdout.toString('utf8').trim()) }
}

/** The text of the refusal printed for Clause 01a1ece9-97ec-736f-99a3-80b76efc800b. */
export function gitRequiredMessage(detail: string): string {
	return `workspace.git_required: UIUX needs Git. ${detail} Put the Workspace in a Git repository (git init), and make sure git can be run.`
}
