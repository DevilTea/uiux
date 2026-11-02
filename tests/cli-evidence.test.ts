import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { CAPTURE_BATCH_SIZE, runEvidenceCommand, type EvidenceCommandOptions } from '../src/cli/evidence'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { FileNativePersistence } from '../src/persistence/file-native'
import { acquireServerHold } from '../src/persistence/server-hold'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createCurrentWorkspace, writeManifest, v5Manifest } from './support/workspace-layout'

/**
 * `uiux evidence capture` (the Command-line interface Contract's `evidence capture` Clauses; Rule
 * 01a115cd-c395-72b0-be67-4a77c4d2ade4, issue #466) on a fake HTTP client: the argument and credential
 * rules, how the selection and the server hold become requests, the output, and the exit status. The run
 * against a real server is `tests/cli-evidence-server.test.ts`.
 */
const execute = promisify(execFile)
const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'uiux.mjs')
const VIEW = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'uiux_t_secret-token-value-for-tests'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-cli-evidence-')))
	roots.push(root)
	return root
}

function aView(): ViewResource {
	return {
		id: VIEW,
		name: 'Capture me',
		feature: 'demo',
		ir: { type: 'RootShell', id: 'root', slots: {} },
		variants: { alt: { state: {} } },
		spec: { intent: 'Be captured.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
	} as unknown as ViewResource
}

/** A Workspace with one View (Variant `alt`), two viewports and two themes, and a default-Locale file. */
async function makeWorkspace(): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await makeRoot()
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, {
		viewports: { desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } }, mobile: { label: 'Mobile', dimensions: { width: 375, height: 667 } } },
		themes: { light: { label: 'Light' }, dark: { label: 'Dark' } },
	})
	await persistence.locales.create('en-US', {})
	await persistence.views.create(VIEW, aView())
	return { root, persistence }
}

type Sent = { url: string; headers: Record<string, string>; redirect: string | undefined; contexts: ResolvedRenderContext[] }
type Answer = (contexts: ResolvedRenderContext[], call: number) => Response | Promise<Response>

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** The server's answer to a capture request in which every context is captured, or those `failing` fail. */
function captureAnswer(failing: (context: ResolvedRenderContext) => boolean = () => false): Answer {
	return (contexts) => {
		const results = contexts.map((context, index) => failing(context)
			? { context, status: 'failed', diagnostics: [{ code: 'capture.execution_failed', path: '/capture', message: 'boom' }] }
			: { context, status: 'captured', evidenceDigest: `sha256:${String(index).padStart(64, 'e')}`, screenshotDigest: `sha256:${String(index).padStart(64, 'a')}` })
		const captured = results.filter(result => result.status === 'captured').length
		const failed = results.length - captured
		const status = failed === 0 ? 'ok' : captured === 0 ? 'failed' : 'incomplete'
		return jsonResponse(status === 'ok' ? 200 : status === 'incomplete' ? 207 : 422, { status, results, summary: { total: results.length, captured, failed }, executedAt: '2026-11-02T00:00:00.000Z' })
	}
}

async function run(argv: string[], options: Readonly<{ root: string; answer?: Answer; env?: Record<string, string | undefined>; stdin?: string; extra?: Partial<EvidenceCommandOptions> }>) {
	const stdout: string[] = []
	const stderr: string[] = []
	const sent: Sent[] = []
	let calls = 0
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as { contexts: ResolvedRenderContext[] }
		sent.push({ url: String(input), headers: init?.headers as Record<string, string>, redirect: init?.redirect, contexts: body.contexts })
		return options.answer ? options.answer(body.contexts, calls++) : captureAnswer()(body.contexts, calls++)
	}) as typeof fetch
	const status = await runEvidenceCommand({
		argv: ['capture', ...argv],
		cwd: options.root,
		env: options.env ?? { UIUX_TOKEN: TOKEN },
		fetch: fetchImpl,
		...(options.stdin === undefined ? {} : { readStdin: async () => options.stdin! }),
		stdout: line => stdout.push(line),
		stderr: line => stderr.push(line),
		...options.extra,
	})
	return { status, stdout, stderr, sent }
}

const ORIGIN = 'http://127.0.0.1:4555'
const baseArgs = (root: string) => ['--workspace', root, '--origin', ORIGIN]

describe('uiux evidence capture: usage (exit status 2)', () => {
	it('refuses what it cannot run, sending nothing', async () => {
		const { root } = await makeWorkspace()
		const cases: [string[], string][] = [
			[[], 'name what to capture'],
			[['--all', '--view', VIEW], '--all cannot be combined'],
			[['--variant', 'alt'], 'need --view'],
			[['--locale', 'en-US'], 'need --view'],
			[['--view', VIEW, '--bogus'], 'bogus'],
			[['--view', ''], 'non-empty'],
			[['--all', '--origin', 'not a url'], '--origin must be a URL'],
			[['--all', '--origin', 'ftp://example.test'], 'http:// or https://'],
			[['--token', TOKEN, '--all'], 'token'],
			[['--view', 'missing'], 'no View "missing"'],
			[['--view', VIEW, '--locale', 'fr-FR'], 'no Locale "fr-FR"'],
			[['--view', VIEW, '--viewport', 'tablet'], 'no viewport preset "tablet"'],
			[['--view', VIEW, '--theme', 'sepia'], 'no theme "sepia"'],
			[['--view', VIEW, '--variant', 'gone'], 'no Variant "gone"'],
		]
		for (const [args, message] of cases) {
			const result = await run([...args, '--workspace', root, ...(args.includes('--origin') ? [] : ['--origin', ORIGIN])], { root })
			expect(result.status, args.join(' ')).toBe(2)
			expect(result.stderr.join('\n'), args.join(' ')).toContain(message)
			expect(result.sent, args.join(' ')).toEqual([])
		}
		const noSubcommand = await runEvidenceCommand({ argv: [], stdout: () => undefined, stderr: () => undefined })
		expect(noSubcommand).toBe(2)
		const unknownSubcommand = await runEvidenceCommand({ argv: ['list'], stdout: () => undefined, stderr: () => undefined })
		expect(unknownSubcommand).toBe(2)
	})

	it('refuses an unusable Workspace root before reading a Token or sending anything', async () => {
		const root = await makeRoot()
		await writeManifest(root, v5Manifest())
		const old = await run(['--all', ...baseArgs(root)], { root, env: {} })
		expect(old.status).toBe(2)
		expect(old.stderr.join('\n')).toContain('schemaVersion')
		expect(old.sent).toEqual([])
		const empty = await makeRoot()
		const missing = await run(['--all', ...baseArgs(empty)], { root: empty })
		expect(missing.status).toBe(2)
		expect(missing.sent).toEqual([])
	})
})

describe('uiux evidence capture: the credential', () => {
	it('reads the Token from UIUX_TOKEN, from a file or from standard input, and sends it only as a bearer credential', async () => {
		const { root } = await makeWorkspace()
		const tokenFile = join(await makeRoot(), 'token')
		await writeFile(tokenFile, `${TOKEN}\n`)
		const fromEnv = await run(['--view', VIEW, ...baseArgs(root)], { root })
		const fromFile = await run(['--view', VIEW, '--token-file', tokenFile, ...baseArgs(root)], { root, env: {} })
		const fromStdin = await run(['--view', VIEW, '--token-file', '-', ...baseArgs(root)], { root, env: {}, stdin: `${TOKEN}\n` })
		for (const [label, result] of [['UIUX_TOKEN', fromEnv], ['a file', fromFile], ['stdin', fromStdin]] as const) {
			expect(result.status, label).toBe(0)
			expect(result.sent, label).toHaveLength(1)
			expect(result.sent[0]!.headers.authorization, label).toBe(`Bearer ${TOKEN}`)
			expect(result.sent[0]!.url, label).toBe(`${ORIGIN}/api/evidence/capture`)
			// The Token is never printed.
			expect([...result.stdout, ...result.stderr].join('\n'), label).not.toContain(TOKEN)
		}
	})

	it('prefers --token-file over UIUX_TOKEN, and refuses to run without a Token or with an unusable one', async () => {
		const { root } = await makeWorkspace()
		const tokenFile = join(await makeRoot(), 'token')
		await writeFile(tokenFile, 'from-the-file')
		const preferred = await run(['--view', VIEW, '--token-file', tokenFile, ...baseArgs(root)], { root })
		expect(preferred.sent[0]!.headers.authorization).toBe('Bearer from-the-file')

		for (const [label, env, args, stdin] of [
			['no Token', {}, [], undefined],
			['an empty UIUX_TOKEN', { UIUX_TOKEN: '  ' }, [], undefined],
			['an empty stdin', {}, ['--token-file', '-'], ''],
			['a missing file', {}, ['--token-file', join(root, 'missing')], undefined],
			['a Token with whitespace', { UIUX_TOKEN: 'two words' }, [], undefined],
		] as const) {
			const result = await run(['--view', VIEW, ...args, ...baseArgs(root)], { root, env, ...(stdin === undefined ? {} : { stdin }) })
			expect(result.status, label).toBe(2)
			expect(result.sent, label).toEqual([])
			expect(result.stderr.join('\n'), label).not.toContain('two words')
		}
	})
})

describe('uiux evidence capture: the selection and the server', () => {
	it('sends the resolved explicit contexts of --all in batches', async () => {
		const { root } = await makeWorkspace()
		const result = await run(['--all', ...baseArgs(root)], { root })
		// 1 View x 1 Locale x 2 viewports x 2 themes, base context only.
		const contexts = result.sent.flatMap(request => request.contexts)
		expect(contexts).toHaveLength(4)
		expect(contexts.every(context => context.viewId === VIEW && context.locale === 'en-US' && !('variantName' in context))).toBe(true)
		expect(contexts.map(context => `${context.viewportId}/${context.themeId}`)).toEqual(['desktop/dark', 'desktop/light', 'mobile/dark', 'mobile/light'])
		expect(contexts.find(context => context.viewportId === 'mobile')!.viewport).toEqual({ width: 375, height: 667 })
		expect(result.status).toBe(0)
	})

	it(`splits a long list into requests of at most ${CAPTURE_BATCH_SIZE} contexts`, async () => {
		const { root, persistence } = await makeWorkspace()
		for (const locale of ['de-DE', 'fr-FR', 'it-IT', 'es-ES']) await persistence.locales.create(locale, {})
		const result = await run(['--all', ...baseArgs(root)], { root })
		// 1 View x 5 Locales x 2 viewports x 2 themes = 20 contexts.
		expect(result.sent.map(request => request.contexts.length)).toEqual([CAPTURE_BATCH_SIZE, CAPTURE_BATCH_SIZE, 20 - 2 * CAPTURE_BATCH_SIZE])
		expect(result.stdout.at(-1)).toBe('Captured 20 of 20 contexts, 0 failed.')
		expect(result.status).toBe(0)
	})

	it('captures the named Variant next to the base context only when it is named', async () => {
		const { root } = await makeWorkspace()
		const named = await run(['--view', VIEW, '--variant', 'alt', '--viewport', 'mobile', '--theme', 'light', ...baseArgs(root)], { root })
		expect(named.sent[0]!.contexts.map(context => context.variantName)).toEqual([undefined, 'alt'])
		const unnamed = await run(['--view', VIEW, '--viewport', 'mobile', '--theme', 'light', ...baseArgs(root)], { root })
		expect(unnamed.sent[0]!.contexts.map(context => context.variantName)).toEqual([undefined])
	})

	it('succeeds without a request when nothing is selected', async () => {
		const root = await makeRoot()
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await createCurrentWorkspace(persistence)
		const text = await run(['--all', '--workspace', root], { root })
		expect(text.status).toBe(0)
		expect(text.sent).toEqual([])
		const json = await run(['--all', '--json', '--workspace', root], { root })
		expect(json.status).toBe(0)
		expect(JSON.parse(json.stdout[0]!)).toEqual({ status: 'ok', results: [], summary: { selected: 0, captured: 0, failed: 0, notAttempted: 0 } })
	})

	it('finds the server in the hold of the running server of the Workspace, and uses --origin over it', async () => {
		const { root, persistence } = await makeWorkspace()
		const hold = await acquireServerHold(root, { origin: 'http://127.0.0.1:4777', layout: persistence.layout })
		try {
			const fromHold = await run(['--view', VIEW, '--workspace', root], { root })
			expect(fromHold.status).toBe(0)
			expect(fromHold.sent[0]!.url).toBe('http://127.0.0.1:4777/api/evidence/capture')
			const explicit = await run(['--view', VIEW, '--workspace', root, '--origin', 'https://uiux.example.test/ignored/path'], { root })
			expect(explicit.sent[0]!.url).toBe('https://uiux.example.test/api/evidence/capture')
		}
		finally {
			await hold?.release()
		}
	})

	it('exits 1, saying how to start a server, when no server runs for the Workspace and no --origin is given', async () => {
		const { root } = await makeWorkspace()
		const result = await run(['--view', VIEW, '--workspace', root], { root })
		expect(result.status).toBe(1)
		expect(result.stderr.join('\n')).toContain('uiux dev')
		expect(result.sent).toEqual([])
	})
})

describe('uiux evidence capture: output and exit status', () => {
	it('prints one tab-separated line per context and a count, exits 0 when every context is captured', async () => {
		const { root } = await makeWorkspace()
		const result = await run(['--view', VIEW, '--variant', 'alt', '--viewport', 'desktop', '--theme', 'light', ...baseArgs(root)], { root })
		expect(result.status).toBe(0)
		expect(result.stdout).toEqual([
			`captured\t${VIEW}\t-\ten-US\tdesktop\tlight\tsha256:${'e'.repeat(63)}0`,
			`captured\t${VIEW}\talt\ten-US\tdesktop\tlight\tsha256:${'e'.repeat(63)}1`,
			'Captured 2 of 2 contexts, 0 failed.',
		])
		expect(result.stderr).toEqual([])
	})

	it('exits 1 for an incomplete capture, naming each failed context on standard error', async () => {
		const { root } = await makeWorkspace()
		const result = await run(['--view', VIEW, '--variant', 'alt', ...baseArgs(root)], { root, answer: captureAnswer(context => context.variantName === 'alt') })
		expect(result.status).toBe(1)
		expect(result.stdout.at(-1)).toBe('Captured 1 of 2 contexts, 1 failed.')
		expect(result.stdout[1]).toMatch(/^failed\t/)
		expect(result.stderr.join('\n')).toContain(`failed ${VIEW}/alt en-US desktop dark: capture.execution_failed: boom`)
	})

	it('exits 1 when every context fails', async () => {
		const { root } = await makeWorkspace()
		const result = await run(['--view', VIEW, ...baseArgs(root)], { root, answer: captureAnswer(() => true) })
		expect(result.status).toBe(1)
		expect(result.stdout.at(-1)).toBe('Captured 0 of 1 contexts, 1 failed.')
	})

	it('prints the capture result as one JSON object with --json, without the Evidence records', async () => {
		const { root } = await makeWorkspace()
		const result = await run(['--view', VIEW, '--variant', 'alt', '--json', '--viewport', 'desktop', '--theme', 'light', ...baseArgs(root)], { root, answer: captureAnswer(context => context.variantName === 'alt') })
		expect(result.status).toBe(1)
		expect(result.stdout).toHaveLength(1)
		expect(JSON.parse(result.stdout[0]!)).toEqual({
			status: 'incomplete',
			results: [
				{ context: { viewId: VIEW, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }, status: 'captured', evidenceDigest: `sha256:${'e'.repeat(63)}0`, screenshotDigest: `sha256:${'a'.repeat(63)}0` },
				{ context: { viewId: VIEW, variantName: 'alt', locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }, status: 'failed', diagnostics: [{ code: 'capture.execution_failed', path: '/capture', message: 'boom' }] },
			],
			summary: { selected: 2, captured: 1, failed: 1, notAttempted: 0 },
		})
	})

	it('exits 1 when the server refuses the Token or the key, and prints no data', async () => {
		const { root } = await makeWorkspace()
		const unauthorized = await run(['--view', VIEW, '--json', ...baseArgs(root)], { root, answer: () => jsonResponse(401, { status: 'unauthorized', message: 'A credential is required.' }) })
		expect(unauthorized.status).toBe(1)
		expect(unauthorized.stdout).toEqual([])
		expect(unauthorized.stderr.join('\n')).toContain('did not accept the Token (401)')
		const forbidden = await run(['--view', VIEW, ...baseArgs(root)], { root, answer: () => jsonResponse(403, { status: 'blocked', code: 'auth.scope_denied', message: 'Missing permission key evidence.capture.', diagnostics: [] }) })
		expect(forbidden.status).toBe(1)
		expect(forbidden.stdout).toEqual([])
		expect(forbidden.stderr.join('\n')).toContain('(403): Missing permission key evidence.capture.')
		for (const result of [unauthorized, forbidden]) expect(result.stderr.join('\n')).not.toContain(TOKEN)
	})

	it('exits 1 when no server answers, and stops after the first refused request, counting what was not captured', async () => {
		const { root } = await makeWorkspace()
		const down = await runEvidenceCommand({
			argv: ['capture', '--view', VIEW, ...baseArgs(root)],
			cwd: root,
			env: { UIUX_TOKEN: TOKEN },
			fetch: (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) }) }) as typeof fetch,
			stdout: () => undefined,
			stderr: () => undefined,
		})
		expect(down).toBe(1)

		const { persistence } = await makeWorkspace().then(async workspace => {
			for (const locale of ['de-DE', 'fr-FR', 'it-IT', 'es-ES']) await workspace.persistence.locales.create(locale, {})
			return workspace
		})
		const result = await run(['--all', '--workspace', persistence.root, '--origin', ORIGIN], { root: persistence.root, answer: (contexts, call) => call === 0 ? captureAnswer()(contexts, call) : jsonResponse(403, { status: 'blocked', message: 'no.' }) })
		expect(result.status).toBe(1)
		// 20 contexts: the first batch of 8 is captured, the second is refused, and the third is never sent.
		expect(result.sent.map(request => request.contexts.length)).toEqual([CAPTURE_BATCH_SIZE, CAPTURE_BATCH_SIZE])
		// The summary reports the selection: 8 of 20 captured, 12 not attempted.
		expect(result.stdout.at(-1)).toBe('Captured 8 of 20 contexts, 0 failed, 12 not attempted.')
		expect(result.stderr.join('\n')).toContain('12 of 20 contexts were not attempted')
		const json = await run(['--all', '--json', '--workspace', persistence.root, '--origin', ORIGIN], { root: persistence.root, answer: (contexts, call) => call === 0 ? captureAnswer()(contexts, call) : jsonResponse(403, { status: 'blocked', message: 'no.' }) })
		expect(json.status).toBe(1)
		const parsed = JSON.parse(json.stdout[0]!) as { status: string; results: unknown[]; summary: unknown }
		expect(parsed.status).toBe('incomplete')
		expect(parsed.results).toHaveLength(8)
		expect(parsed.summary).toEqual({ selected: 20, captured: 8, failed: 0, notAttempted: 12 })
	})

	it('stops after a request that the server refuses for every context alike, reporting the rest as not attempted', async () => {
		const { persistence } = await makeWorkspace().then(async workspace => {
			for (const locale of ['de-DE', 'fr-FR', 'it-IT', 'es-ES']) await workspace.persistence.locales.create(locale, {})
			return workspace
		})
		const refuse = (code: string): Answer => contexts => jsonResponse(422, {
			status: 'failed',
			results: contexts.map(context => ({ context, status: 'failed', diagnostics: [{ code, path: '/x', message: `Refused: ${code}.` }] })),
			summary: { total: contexts.length, captured: 0, failed: contexts.length },
		})
		for (const code of ['capture.kit_build_not_ready', 'i18n.missing_default_locale', 'workspace.schema_unsupported', 'workspace.manifest_missing', 'capture.browser_launch_failed']) {
			const result = await run(['--all', '--workspace', persistence.root, '--origin', ORIGIN], { root: persistence.root, answer: refuse(code) })
			expect(result.status, code).toBe(1)
			// 20 contexts: one request of 8 is refused whole, and the other 12 are never sent.
			expect(result.sent.map(request => request.contexts.length), code).toEqual([CAPTURE_BATCH_SIZE])
			expect(result.stdout.at(-1), code).toBe('Captured 0 of 20 contexts, 8 failed, 12 not attempted.')
			const errors = result.stderr.join('\n')
			expect(errors, code).toContain(code)
			expect(errors, code).toContain('refused every context of that request alike')
			expect(errors, code).toContain('12 of 20 contexts were not attempted')
		}
	})

	it('goes on after a 422 whose failures belong to single contexts, and after a 207', async () => {
		const { persistence } = await makeWorkspace().then(async workspace => {
			for (const locale of ['de-DE', 'fr-FR', 'it-IT', 'es-ES']) await workspace.persistence.locales.create(locale, {})
			return workspace
		})
		// Every context of every request fails on its own (a View that cannot render): a 422, but not a refusal for all alike.
		const every = await run(['--all', '--workspace', persistence.root, '--origin', ORIGIN], { root: persistence.root, answer: captureAnswer(() => true) })
		expect(every.sent.map(request => request.contexts.length)).toEqual([CAPTURE_BATCH_SIZE, CAPTURE_BATCH_SIZE, 20 - 2 * CAPTURE_BATCH_SIZE])
		expect(every.status).toBe(1)
		expect(every.stdout.at(-1)).toBe('Captured 0 of 20 contexts, 20 failed.')
		// A request in which only some results carry a server-wide code is not a refusal for all alike.
		const mixed: Answer = contexts => jsonResponse(422, {
			status: 'failed',
			results: contexts.map((context, index) => ({ context, status: 'failed', diagnostics: [{ code: index === 0 ? 'capture.kit_build_not_ready' : 'view.not_found', path: '/x', message: 'x' }] })),
			summary: { total: contexts.length, captured: 0, failed: contexts.length },
		})
		const some = await run(['--all', '--workspace', persistence.root, '--origin', ORIGIN], { root: persistence.root, answer: mixed })
		expect(some.sent).toHaveLength(3)
		// A 207 (some contexts captured) does not stop the run either.
		const partial = await run(['--all', '--workspace', persistence.root, '--origin', ORIGIN], { root: persistence.root, answer: captureAnswer(context => context.themeId === 'dark') })
		expect(partial.sent).toHaveLength(3)
		expect(partial.status).toBe(1)
	})
})

describe('uiux evidence capture: a Token never leaves the credential sources', () => {
	it('does not repeat a Token-shaped argument in an error, even one typed in the wrong place', async () => {
		const { root } = await makeWorkspace()
		const secret = 'uiux_t_typed-where-a-path-belongs'
		for (const args of [['capture', '--view', VIEW, '--token-file', secret], [secret], ['capture', '--view', VIEW, secret], ['capture', '--view', VIEW, `--${secret}`], ['capture', '--view', VIEW, `--${secret}=${secret}`]]) {
			const stderr: string[] = []
			const status = await runEvidenceCommand({ argv: [...args, ...baseArgs(root)], cwd: root, env: {}, fetch: (async () => { throw new Error('never sent') }) as typeof fetch, stdout: line => stderr.push(line), stderr: line => stderr.push(line) })
			expect(status, args.join(' ')).toBe(2)
			expect(stderr.join('\n'), args.join(' ')).not.toContain(secret)
		}
	})

	it('refuses --token-file - on an interactive terminal', async () => {
		const { root } = await makeWorkspace()
		const stderr: string[] = []
		const status = await runEvidenceCommand({ argv: ['capture', '--view', VIEW, '--token-file', '-', ...baseArgs(root)], cwd: root, env: {}, stdinIsTTY: true, fetch: (async () => { throw new Error('never sent') }) as typeof fetch, stdout: () => undefined, stderr: line => stderr.push(line) })
		expect(status).toBe(2)
		expect(stderr.join('\n')).toContain('interactive terminal')
	})

	it('warns once about a Token sent in clear text to a non-loopback http origin, and refuses redirects', async () => {
		const { root } = await makeWorkspace()
		const lan = await run(['--view', VIEW, '--workspace', root, '--origin', 'http://10.0.0.5:3000'], { root })
		expect(lan.status).toBe(0)
		expect(lan.stderr.filter(line => line.includes('clear text'))).toHaveLength(1)
		expect(lan.sent[0]!.redirect).toBe('error')
		for (const origin of ['http://127.0.0.1:3000', 'http://localhost:3000', 'https://uiux.example.test']) {
			const quiet = await run(['--view', VIEW, '--workspace', root, '--origin', origin], { root })
			expect(quiet.stderr, origin).toEqual([])
		}
	})
})

describe('uiux evidence capture: through bin/uiux.mjs', () => {
	it('is listed in help and refuses invalid usage with status 2, with no Token on the command line', async () => {
		const help = await execute(process.execPath, [CLI, '--help'])
		expect(help.stdout).toContain('evidence capture (--all | --view <id>...)')
		expect(help.stdout).toContain('UIUX_TOKEN')
		const failing = (args: string[]) => execute(process.execPath, [CLI, ...args]).then(
			() => ({ code: 0, stderr: '' }),
			(error: { code: number; stderr: string }) => ({ code: error.code, stderr: error.stderr }),
		)
		const failure = await failing(['evidence', 'capture', '--all', '--view', VIEW])
		expect(failure.code).toBe(2)
		expect(failure.stderr).toContain('--all cannot be combined')
		expect((await failing(['evidence', 'export'])).code).toBe(2)
	})
})
