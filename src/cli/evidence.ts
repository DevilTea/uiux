import { lstat, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { parseArgs } from 'node:util'

import type { ResolvedRenderContext } from '../domain/render-context/schema'
import { FileNativePersistence, settledValue } from '../persistence/file-native'
import { resolveWorkspacePath } from '../persistence/paths'
import { readActiveServerHold } from '../persistence/server-hold'
import type { WorkspaceSchemaPolicy } from '../persistence/schema-policy'
import { resolveCaptureContexts, type CaptureSelection, type CaptureWorkspaceFacts } from '../preview/capture-contexts'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'
import { isLoopbackHostname } from '../server/network-access'
import { selectWorkspace } from '../persistence/workspace-selection'
import { writeStderrLine, writeStdoutLine } from './output'

export const EVIDENCE_USAGE = 'evidence capture (--all | --view <id>...) [--variant <name>...] [--locale <tag>...] [--viewport <id>...] [--theme <id>...] [--workspace <dir>] [--origin <url>] [--token-file <path|->] [--json]'

/** The environment variable that carries the Token when `--token-file` is not given. */
export const TOKEN_ENVIRONMENT_VARIABLE = 'UIUX_TOKEN'

/**
 * How many contexts one request carries. Each request shares one browser launch on the server, and
 * a short request keeps a long `--all` run clear of client timeouts and gives a stop point.
 */
export const CAPTURE_BATCH_SIZE = 8

export type EvidenceCommandOptions = Readonly<{
	/** The arguments after `evidence`. */
	argv: readonly string[]
	cwd?: string
	/** The environment `UIUX_TOKEN` is read from; `process.env` by default. */
	env?: Readonly<Record<string, string | undefined>>
	/** Test seam: reads standard input for `--token-file -`. */
	readStdin?: () => Promise<string>
	/** Test seam: whether standard input is an interactive terminal (`process.stdin.isTTY` by default). */
	stdinIsTTY?: boolean
	/** Test seam: the HTTP client; the global `fetch` by default. */
	fetch?: typeof fetch
	stdout?: (line: string) => void
	stderr?: (line: string) => void
	/** Test seam: the Workspace schema policy of the entry check (UIUX's own by default). */
	schemaPolicy?: WorkspaceSchemaPolicy
}>

type Diagnostic = Readonly<{ code?: string; path?: string; message?: string }>

type ContextResult = Readonly<{
	context: ResolvedRenderContext
	status: 'captured' | 'failed'
	evidenceDigest?: string
	screenshotDigest?: string
	diagnostics?: readonly Diagnostic[]
}>

/** A usage error: its message and the usage line are printed and the exit status is 2. */
class UsageError extends Error {}
/** A refusal or failure the command reports with exit status 1. */
class Refusal extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * `uiux evidence capture` (Clauses 01a1144e-… of the Command-line interface Contract): formal
 * Evidence capture through a running `uiux dev` server. The command resolves its selection into an
 * explicit list of render contexts from the selected Workspace on disk, then sends the list to
 * `POST /api/evidence/capture` as the member whose Token it reads from `--token-file` or
 * `UIUX_TOKEN`, so the server stays the one writer and the shared capture service is the one
 * that captures (Rule 01a115cd-c395-72b0-be67-4a77c4d2ade4). The Token is never accepted on the
 * command line and never printed.
 *
 * Returns the exit code: 0 when every context was captured (or none was selected), 1 when the server
 * refuses, none is found or answers, or any context fails, and 2 for invalid usage or an unusable
 * Workspace root.
 */
export async function runEvidenceCommand(options: EvidenceCommandOptions): Promise<number> {
	const out = options.stdout ?? writeStdoutLine
	const err = options.stderr ?? writeStderrLine
	try {
		return await run(options, out, err)
	}
	catch (error) {
		if (error instanceof UsageError) {
			err(`uiux: ${error.message}`)
			err(`Usage: uiux ${EVIDENCE_USAGE}`)
			return 2
		}
		err(`uiux: ${error instanceof Error ? error.message : String(error)}`)
		return 1
	}
}

type ParsedArguments = Readonly<{
	selection: CaptureSelection
	workspace: string | undefined
	origin: string | undefined
	tokenFile: string | undefined
	json: boolean
}>

/** `--origin` as an origin; an unparsable or non-HTTP value is invalid usage. */
function normalizedOrigin(value: string | undefined): string | undefined {
	if (value === undefined) return undefined
	let url: URL
	try { url = new URL(value) }
	catch { throw new UsageError('--origin must be a URL such as http://127.0.0.1:3000.') }
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('--origin must be an http:// or https:// URL.')
	return url.origin
}

/**
 * A `parseArgs` failure without the argument value: a value can be a Token typed into the wrong
 * place, so the message never repeats one. An option name is repeated only when it is a plain
 * option name.
 */
function describeArgumentError(error: unknown): string {
	const code = isRecord(error) ? error.code : undefined
	const message = error instanceof Error ? error.message : ''
	if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') return 'unexpected argument.'
	if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
		const name = /'(--[A-Za-z][A-Za-z-]{0,23})'/.exec(message)?.[1]
		return name ? `unknown option ${name}.` : 'unknown option.'
	}
	if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
		const name = /'(--[A-Za-z][A-Za-z-]{0,23})(?: <value>)?'/.exec(message)?.[1]
		return name ? `option ${name} needs a value.` : 'an option needs a value.'
	}
	return 'invalid arguments.'
}

function parseArguments(argv: readonly string[]): ParsedArguments {
	const [subcommand, ...args] = argv
	if (subcommand !== 'capture') throw new UsageError(subcommand === undefined ? 'evidence takes capture.' : 'unknown evidence command.')
	let values: Record<string, string | boolean | (string | boolean)[] | undefined>
	try {
		values = parseArgs({
			args: [...args],
			options: {
				'all': { type: 'boolean' },
				'view': { type: 'string', multiple: true },
				'variant': { type: 'string', multiple: true },
				'locale': { type: 'string', multiple: true },
				'viewport': { type: 'string', multiple: true },
				'theme': { type: 'string', multiple: true },
				'workspace': { type: 'string' },
				'origin': { type: 'string' },
				'token-file': { type: 'string' },
				'json': { type: 'boolean' },
			},
			allowPositionals: false,
			strict: true,
		}).values
	}
	catch (error) {
		throw new UsageError(describeArgumentError(error))
	}
	const list = (name: string): string[] | undefined => {
		const value = values[name] as string[] | undefined
		if (value?.some(item => item === '')) throw new UsageError(`--${name} needs a non-empty value.`)
		return value
	}
	const single = (name: string): string | undefined => {
		const value = values[name] as string | undefined
		if (value === '') throw new UsageError(`--${name} needs a value.`)
		return value
	}
	const views = list('view')
	const variants = list('variant')
	const locales = list('locale')
	const viewports = list('viewport')
	const themes = list('theme')
	const all = values.all === true
	let selection: CaptureSelection
	if (all) {
		if (views || variants || locales || viewports || themes) throw new UsageError('--all cannot be combined with --view, --variant, --locale, --viewport or --theme.')
		selection = { all: true }
	}
	else {
		if (!views) throw new UsageError(variants || locales || viewports || themes ? '--variant, --locale, --viewport and --theme need --view.' : 'name what to capture: --all or one or more --view <id>.')
		selection = { views, ...(variants ? { variants } : {}), ...(locales ? { locales } : {}), ...(viewports ? { viewports } : {}), ...(themes ? { themes } : {}) }
	}
	return { selection, workspace: single('workspace'), origin: normalizedOrigin(single('origin')), tokenFile: single('token-file'), json: values.json === true }
}

/** The Token: the file named by `--token-file` (`-` is standard input), else `UIUX_TOKEN`. */
async function readToken(parsed: ParsedArguments, options: EvidenceCommandOptions): Promise<string> {
	let text: string | undefined
	if (parsed.tokenFile !== undefined) {
		if (parsed.tokenFile === '-' && !options.readStdin && (options.stdinIsTTY ?? process.stdin.isTTY)) throw new UsageError('--token-file - reads the Token from standard input, which is an interactive terminal; pipe the Token in, or use a file.')
		try {
			text = parsed.tokenFile === '-' ? await (options.readStdin ?? readProcessStdin)() : await readFile(parsed.tokenFile, 'utf8')
		}
		catch (error) {
			const code = isRecord(error) && typeof error.code === 'string' ? ` (${error.code})` : ''
			throw new UsageError(`cannot read the Token from ${parsed.tokenFile === '-' ? 'standard input' : 'the --token-file path'}${code}.`)
		}
	}
	else {
		text = (options.env ?? process.env)[TOKEN_ENVIRONMENT_VARIABLE]
	}
	const token = text?.trim()
	if (!token) throw new UsageError(`no Token: set ${TOKEN_ENVIRONMENT_VARIABLE} or pass --token-file <path> (- reads standard input).`)
	if (/\s/.test(token)) throw new UsageError('the Token must be one line without whitespace.')
	return token
}

async function readProcessStdin(): Promise<string> {
	const chunks: Buffer[] = []
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array))
	return Buffer.concat(chunks).toString('utf8')
}

/** The registries and Views the selection is resolved against, read from the Workspace on disk. */
async function readFacts(persistence: FileNativePersistence): Promise<CaptureWorkspaceFacts> {
	const { resource } = await persistence.inspectWorkspace()
	if (!resource) throw new UsageError('the Workspace manifest is missing or unreadable.')
	const locales = await persistence.locales.discover()
	const views: { id: string; variants: readonly string[] }[] = []
	for (const { key, read } of await persistence.views.readAllInspected()) {
		// A View file that cannot be read has no context to capture; the server judges the rest.
		let inspected: Awaited<ReturnType<typeof persistence.views.readInspected>>
		try { inspected = settledValue(read) }
		catch { continue }
		if (inspected?.resource) views.push({ id: key, variants: Object.keys(inspected.resource.variants ?? {}) })
	}
	return { workspace: resource, locales, views }
}

/** The origin of the server: `--origin`, else the loopback origin that this host's running server records in its hold. */
async function resolveOrigin(parsed: ParsedArguments, root: string, persistence: FileNativePersistence): Promise<string> {
	if (parsed.origin !== undefined) return parsed.origin
	const hold = await readActiveServerHold(root, persistence.layout).catch(() => undefined)
	if (hold?.origin && hold.hostname === hostname()) {
		try {
			const recorded = new URL(hold.origin)
			if (recorded.protocol === 'http:' && isLoopbackHostname(recorded.hostname)) return recorded.origin
		}
		catch { /* no usable origin recorded: refused below */ }
	}
	throw new Refusal(`no uiux dev server is serving the Workspace ${root} on this host. Start one with uiux dev, or pass --origin <url>.`)
}

function describeDiagnostics(diagnostics: readonly Diagnostic[] | undefined): string {
	return (diagnostics ?? []).map(diagnostic => `${diagnostic.code ?? 'error'}: ${diagnostic.message ?? ''}`.trim()).join('; ')
}

type Batch =
	| Readonly<{ ok: true; results: readonly ContextResult[]; precondition: boolean }>
	| Readonly<{ ok: false; message: string }>

/** One request: the server's per-context results, or why the whole request was refused. */
async function sendBatch(fetchImpl: typeof fetch, origin: string, token: string, contexts: readonly ResolvedRenderContext[]): Promise<Batch> {
	let response: Response
	try {
		response = await fetchImpl(`${origin}/api/evidence/capture`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'accept': 'application/json', 'authorization': `Bearer ${token}` },
			body: JSON.stringify({ contexts }),
			redirect: 'error',
		})
	}
	catch (error) {
		const cause = error instanceof Error && isRecord(error.cause) && typeof error.cause.code === 'string' ? ` (${error.cause.code})` : ''
		return { ok: false, message: `no server answered at ${origin}${cause}.` }
	}
	let body: unknown
	try { body = await response.json() }
	catch { body = undefined }
	const record = isRecord(body) ? body : undefined
	if (Array.isArray(record?.results)) {
		const results: ContextResult[] = []
		for (const [index, raw] of (record.results as unknown[]).entries()) {
			if (!isRecord(raw)) continue
			const context = (isRecord(raw.context) ? raw.context : contexts[index]) as ResolvedRenderContext | undefined
			if (!context) continue
			results.push({
				context,
				status: raw.status === 'captured' ? 'captured' : 'failed',
				...(typeof raw.evidenceDigest === 'string' ? { evidenceDigest: raw.evidenceDigest } : {}),
				...(typeof raw.screenshotDigest === 'string' ? { screenshotDigest: raw.screenshotDigest } : {}),
				...(Array.isArray(raw.diagnostics) && raw.diagnostics.length ? { diagnostics: raw.diagnostics as Diagnostic[] } : typeof raw.error === 'string' ? { diagnostics: [{ message: raw.error }] } : {}),
			})
		}
		// 422 answers a request in which no context was captured: a refusal before any browser ran (the kit build, the default Locale or the registries) or a batch that failed whole. Either way the run stops.
		return { ok: true, results, precondition: response.status === 422 }
	}
	if (response.status === 401) return { ok: false, message: 'the server did not accept the Token (401).' }
	const detail = typeof record?.message === 'string' ? record.message : describeDiagnostics(Array.isArray(record?.diagnostics) ? record.diagnostics as Diagnostic[] : undefined)
	return { ok: false, message: `the server refused the capture (${response.status})${detail ? `: ${detail}` : '.'}` }
}

async function run(options: EvidenceCommandOptions, out: (line: string) => void, err: (line: string) => void): Promise<number> {
	const parsed = parseArguments(options.argv)
	const schemaPolicy = options.schemaPolicy ?? PRODUCT_WORKSPACE_SCHEMA_POLICY
	const selected = selectWorkspace({ ...(parsed.workspace === undefined ? {} : { workspace: parsed.workspace }), cwd: options.cwd ?? process.cwd() }, schemaPolicy)
	if (!selected.ok) {
		err(`uiux: ${selected.message}`)
		return 2
	}
	const manifest = await lstat(resolveWorkspacePath(selected.root, selected.layout.manifestPath)).catch(() => undefined)
	if (!manifest?.isFile()) {
		err(`uiux: ${selected.root} is not an initialized UIUX Workspace (no ${selected.layout.manifestPath}). Run uiux init first.`)
		return 2
	}
	const token = await readToken(parsed, options)
	const persistence = new FileNativePersistence({ root: selected.root, schemaPolicy, layout: selected.layout })
	const resolved = resolveCaptureContexts(await readFacts(persistence), parsed.selection)
	if (!resolved.ok) throw new UsageError(resolved.message)
	const contexts = resolved.contexts
	if (contexts.length === 0) {
		err('uiux: no render contexts to capture.')
		if (parsed.json) out(JSON.stringify({ status: 'ok', results: [], summary: { selected: 0, captured: 0, failed: 0, notAttempted: 0 } }))
		return 0
	}

	const origin = await resolveOrigin(parsed, selected.root, persistence)
	if (origin.startsWith('http://') && !isLoopbackHostname(new URL(origin).hostname))
		err(`uiux: warning: ${origin} is plain http on a non-loopback host, so the Token travels in clear text.`)
	const fetchImpl = options.fetch ?? fetch
	const results: ContextResult[] = []
	let stopped: string | undefined
	for (let offset = 0; offset < contexts.length; offset += CAPTURE_BATCH_SIZE) {
		const batch = await sendBatch(fetchImpl, origin, token, contexts.slice(offset, offset + CAPTURE_BATCH_SIZE))
		if (!batch.ok) {
			stopped = batch.message
			break
		}
		results.push(...batch.results)
		if (batch.precondition) {
			stopped = 'the server answered 422: no context of that request was captured, so the run stops.'
			break
		}
	}

	const captured = results.filter(result => result.status === 'captured').length
	const failed = results.length - captured
	const notAttempted = contexts.length - results.length
	const status = captured === contexts.length ? 'ok' : captured === 0 ? 'failed' : 'incomplete'
	if (parsed.json) {
		if (results.length > 0)
			out(JSON.stringify({ status, results, summary: { selected: contexts.length, captured, failed, notAttempted } }))
	}
	else {
		for (const result of results) {
			const { context } = result
			out([result.status, context.viewId, context.variantName ?? '-', context.locale, context.viewportId, context.themeId, result.evidenceDigest ?? '-'].join('\t'))
		}
		if (results.length > 0) out(`Captured ${captured} of ${contexts.length} contexts, ${failed} failed${notAttempted > 0 ? `, ${notAttempted} not attempted` : ''}.`)
	}
	for (const result of results) {
		if (result.status === 'failed') {
			const { context } = result
			err(`uiux: failed ${context.viewId}${context.variantName ? `/${context.variantName}` : ''} ${context.locale} ${context.viewportId} ${context.themeId}: ${describeDiagnostics(result.diagnostics) || 'no diagnostic'}`)
		}
	}
	if (stopped) err(`uiux: ${stopped} ${notAttempted} of ${contexts.length} contexts were not attempted.`)
	return captured === contexts.length ? 0 : 1
}
