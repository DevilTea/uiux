#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, normalize, relative, sep } from 'node:path'
import { chromium } from 'playwright'

const tempRoot = await mkdtemp(join(tmpdir(), 'uiux-publication-browser-'))
const publicationRoot = join(tempRoot, 'uiux')
const cli = join(process.cwd(), 'bin', 'uiux.mjs')
// The dogfood Workspace is published from a copy that has version history: Checkpoints in the
// Workspace and host versions under a private UIUX_HOME, never ~/.uiux, and never by running a
// server against design/ itself. The copy sits beside design/ so its Adapter resolves the
// repository's packages exactly as design/ does.
const workspaceCopy = await mkdtemp(join(process.cwd(), '.uiux-publication-smoke-'))
const uiuxHome = await mkdtemp(join(tmpdir(), 'uiux-publication-home-'))

function contentType(path) {
	return ({
		'.css': 'text/css; charset=utf-8',
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.mjs': 'text/javascript; charset=utf-8',
		'.png': 'image/png',
		'.svg': 'image/svg+xml',
	}[extname(path)] || 'application/octet-stream')
}

function safePath(pathname) {
	const decoded = decodeURIComponent(pathname)
	const normalized = normalize(decoded).replace(/^[/\\]+/u, '')
	if (normalized.startsWith('..')) return undefined
	return join(tempRoot, normalized)
}

async function startStaticServer() {
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url || '/', 'http://127.0.0.1')
			let filePath = safePath(url.pathname)
			if (!filePath) {
				response.writeHead(400)
				.end('Bad path')
				return
			}
			let fileStat
			try {
				fileStat = await stat(filePath)
			}
			catch {
				// Like GitHub Pages: a missing path under the site serves the site's 404.html
				// (with status 404), which boots the SPA on deep links such as /uiux/views/<id>.
				const fallback = join(publicationRoot, '404.html')
				try {
					const bytes = await readFile(fallback)
					response.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
					response.end(bytes)
				}
				catch {
					response.writeHead(404)
						.end('Not found')
				}
				return
			}
			if (fileStat.isDirectory()) {
				filePath = join(filePath, 'index.html')
				fileStat = await stat(filePath)
			}
			if (!fileStat.isFile()) {
				response.writeHead(404)
				.end('Not found')
				return
			}
			const bytes = await readFile(filePath)
			response.writeHead(200, {
				'content-type': contentType(filePath),
				'cache-control': 'no-store',
			})
			response.end(bytes)
		}
		catch (error) {
			response.writeHead(500)
				.end(error instanceof Error ? error.message : String(error))
		}
	})

	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
	const address = server.address()
	if (!address || typeof address === 'string')
		throw new Error('Publication smoke could not allocate a local HTTP port.')
	return {
		origin: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
	}
}

function main(page) {
	return page.locator('main').first()
}

async function open(page, path) {
	await page.goto(`${origin}/uiux${path}`, { waitUntil: 'networkidle' })
	await main(page).waitFor()
}

async function expectNoButton(page, name) {
	const count = await main(page).getByRole('button', { name, exact: true }).count()
	if (count !== 0)
		throw new Error(`Published viewer exposed authoring button "${name}" on ${page.url()}.`)
}

async function previewFrame(page) {
	await page.waitForFunction(() => globalThis.document.querySelector('iframe')?.getAttribute('src')?.includes('/uiux/preview?'))
	const frame = page.frames().find(candidate => candidate.url().includes('/uiux/preview?'))
	if (!frame) throw new Error('Published Workbench did not open the Preview iframe.')
	await frame.locator('[data-preview-ready="true"]').waitFor()
	return frame
}

async function waitFor(label, probe, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const value = await probe()
		if (value) return value
		if (Date.now() > deadline) throw new Error(`Publication smoke timed out after ${timeoutMs} ms waiting for ${label}.`)
		await new Promise(resolve => setTimeout(resolve, 100))
	}
}

async function freePort() {
	const probe = createNetServer()
	await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
	const { port } = probe.address()
	await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
	return port
}

async function filesUnder(dir) {
	const entries = await readdir(dir, { recursive: true, withFileTypes: true })
	return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

/** Every file under `dir` with its size and mtime, to show that a run left the directory untouched. */
async function fingerprint(dir) {
	const files = await filesUnder(dir)
	const rows = await Promise.all(files.map(async (file) => {
		const info = await stat(file)
		return `${relative(dir, file)} ${info.size} ${info.mtimeMs}`
	}))
	return rows.sort().join('\n')
}

/**
 * Gives the Workspace copy version history through the packaged server: the Baseline Checkpoint
 * of the first start, an Agent's autosave in the host store (a Locale edited and edited back, so
 * the published content is unchanged), and a named Checkpoint. Answers every version ID.
 */
async function recordHistory() {
	// Host-local runtime state (a live server's hold, persistence lock files) stays behind.
	const runtimeState = /^\.(?:server-hold|persistence[.-]lock)/u
	await cp(join(process.cwd(), 'design'), workspaceCopy, { recursive: true, filter: source => !runtimeState.test(source.split(sep).at(-1)) })
	const env = { ...process.env, UIUX_HOME: uiuxHome }
	const uiuxCli = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', env })
	uiuxCli('member', 'add', 'publication-smoke', '--kind', 'agent', '--role', 'editor', '--workspace', workspaceCopy)
	const token = uiuxCli('token', 'create', '--member', 'publication-smoke', '--workspace', workspaceCopy).match(/uiux_t_\S+/u)?.[0]
	if (!token) throw new Error('uiux token create printed no token.')
	const port = await freePort()
	const server = spawn(process.execPath, ['.output/server/index.mjs'], {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: { ...env, HOST: '127.0.0.1', PORT: String(port), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(port), UIUX_WORKSPACE_ROOT: workspaceCopy },
	})
	let serverOutput = ''
	server.stdout.setEncoding('utf8').on('data', chunk => serverOutput += chunk)
	server.stderr.setEncoding('utf8').on('data', chunk => serverOutput += chunk)
	try {
		const api = async (method, path, body) => {
			const response = await fetch(`http://127.0.0.1:${port}${path}`, {
				method,
				headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			})
			const result = { status: response.status, body: await response.json() }
			if (result.status >= 300) throw new Error(`${method} ${path} returned HTTP ${result.status}: ${JSON.stringify(result.body)}`)
			return result.body
		}
		const versions = async () => (await api('GET', '/api/history/versions?limit=200')).versions
		await waitFor('the Baseline Checkpoint', async () => {
			if (server.exitCode !== null) throw new Error(`The history server exited early.\n${serverOutput}`)
			try { return (await versions()).some(version => version.actor?.id === 'system:baseline') }
			catch { return false }
		}, 20_000)
		const locale = await api('GET', '/api/resources/locale/en-US')
		const edited = await api('PUT', '/api/locales/en-US', { expectedRevision: locale.revision, messages: { ...locale.resource, 'publication.smoke': 'History only' } })
		await api('PUT', '/api/locales/en-US', { expectedRevision: edited.revision, messages: locale.resource })
		await api('POST', '/api/history/checkpoints', { name: 'Publication smoke' })
		const recorded = await waitFor('the host autosave', async () => {
			const listed = await versions()
			return listed.some(version => version.type === 'autosave') && listed.filter(version => version.type === 'checkpoint').length >= 2 ? listed : undefined
		}, 10_000)
		return recorded.map(version => version.id)
	}
	finally {
		server.kill('SIGTERM')
		await new Promise(resolve => server.exitCode !== null || server.signalCode !== null ? resolve() : server.once('exit', resolve))
	}
}

/** Rule 01a11a5e-1c4e-72d9-ad72-364a6549d779: publication output carries no Checkpoints, versions or diffs. */
async function assertNoHistory(snapshot, versionIds) {
	const files = await filesUnder(publicationRoot)
	const paths = files.map(file => relative(publicationRoot, file).split(sep).join('/'))
	const historyPaths = paths.filter(path => path.split('/').some(segment => ['.uiux', 'history', 'checkpoints'].includes(segment)))
	if (historyPaths.length) throw new Error(`Publication output contains history paths:\n${historyPaths.join('\n')}`)
	// The only artifacts are the ones the snapshot references (formal Evidence), never Checkpoint blobs.
	const artifacts = paths.filter(path => path.startsWith('_uiux/artifacts/')).sort()
	const referenced = Object.values(snapshot.files?.artifacts ?? {}).map(entry => entry.file).sort()
	if (JSON.stringify(artifacts) !== JSON.stringify(referenced))
		throw new Error(`Publication artifacts differ from the snapshot's references:\n${JSON.stringify({ artifacts, referenced }, null, 2)}`)
	// The snapshot has no section for history (a Decision's or Review's own `history` is design data),
	// and no history resource kind.
	const sections = ['schemaVersion', 'publicationIdentity', 'generatedAt', 'sourceRevision', 'workspace', 'discovery', 'resources', 'evidence', 'handoff', 'preview', 'files']
	const unexpected = Object.keys(snapshot).filter(key => !sections.includes(key))
	if (unexpected.length) throw new Error(`publication.json has unexpected sections: ${unexpected.join(', ')}`)
	const kinds = [...Object.keys(snapshot.resources ?? {}), ...Object.keys(snapshot.discovery ?? {}), ...Object.keys(snapshot.files ?? {})]
	if (kinds.some(kind => /version|checkpoint|history/iu.test(kind)))
		throw new Error(`publication.json publishes a history kind: ${kinds.join(', ')}`)
	for (const file of files) {
		const text = (await readFile(file)).toString('latin1')
		const leaked = versionIds.find(id => text.includes(id))
		if (leaked) throw new Error(`Publication file ${relative(publicationRoot, file)} names version ${leaked}.`)
	}
	return { files: files.length, versions: versionIds.length }
}

let origin = ''

try {
	const versionIds = await recordHistory()
	const homeBefore = await fingerprint(uiuxHome)
	execFileSync(process.execPath, [
		cli,
		'publish',
		'--workspace', workspaceCopy,
		'--out', publicationRoot,
		'--base', '/uiux/',
		'--source-revision', 'publication-browser-smoke',
	], {
		stdio: 'pipe',
		timeout: 120_000,
		env: { ...process.env, UIUX_HOME: uiuxHome },
	})
	// Building a publication neither reads nor records host history.
	if (await fingerprint(uiuxHome) !== homeBefore) throw new Error('uiux publish changed the host UIUX_HOME.')

	const snapshot = JSON.parse(await readFile(join(publicationRoot, '_uiux', 'publication.json'), 'utf8'))
	const historyCheck = await assertNoHistory(snapshot, versionIds)
	if (snapshot.handoff?.readiness?.implementationReady !== true)
		throw new Error('Dogfood publication lost its Implementation Ready Handoff claim.')
	if (snapshot.preview?.state !== 'valid')
		throw new Error('Dogfood publication did not materialize a valid Preview adapter runtime.')

	const server = await startStaticServer()
	origin = server.origin
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		const consoleProblems = []
		const pageErrors = []
		const requests = []
		page.on('console', message => {
			if (message.type() !== 'error' && message.type() !== 'warning') return
			// A deep link is served by the static 404.html fallback, so the document itself is a 404.
			const location = message.location()?.url ?? ''
			const isDeepLinkDocument = message.text().includes('status of 404')
				&& /\/uiux\/(views|flows)\/[^/]+(\?|$)/.test(location)
			if (!isDeepLinkDocument) consoleProblems.push(`${message.type()}: ${message.text()} (${location})`)
		})
		page.on('pageerror', error => pageErrors.push(error.message))
		page.on('request', request => requests.push(request.url()))

		await page.addInitScript(() => {
			// Pin the Workbench chrome locale so the English labels below are stable.
			localStorage.setItem('uiux.workbench.locale', 'en-US')
		})

		// Overview, with the publication banner.
		await open(page, '/')
		await page.getByText('Published snapshot · read-only', { exact: false }).first().waitFor()

		// /views redirects to the Overview's Views tab, the one View list; a View's render context rides in the query.
		await open(page, '/views')
		await page.waitForURL(/\/uiux\/\?tab=views/)
		await page.locator('[data-view-row]').first().click()
		await page.waitForURL(/\/uiux\/views\/[^/?]+/)
		const frame = await previewFrame(page)
		const iframeTitleIncludes = context => page.waitForFunction(text => globalThis.document.querySelector('iframe')?.getAttribute('title')?.includes(text), context)
		await iframeTitleIncludes('en-US · desktop · dark')
		await page.getByRole('combobox', { name: 'Preview theme' }).click()
		await page.getByRole('option', { name: 'Light' }).click()
		await iframeTitleIncludes('en-US · desktop · light')
		await page.waitForURL(/[?&]theme=light/)
		// A theme change re-renders the same Preview document; it is never reloaded.
		await frame.waitForFunction(() => globalThis.document.querySelector('[data-preview-ready]')?.parentElement?.classList.contains('light'))
		if (await page.getByRole('button', { name: 'Comment', exact: true }).count() !== 0)
			throw new Error('Published viewer exposed the canvas Comment button.')

		// A refresh on the deep link reproduces the context (served by the static 404.html fallback).
		const deepLink = page.url()
		await page.goto(deepLink, { waitUntil: 'networkidle' })
		await previewFrame(page)
		await page.waitForFunction(() => globalThis.document.querySelector('iframe')?.getAttribute('src')?.includes('themeId=light'))
		await iframeTitleIncludes('en-US · desktop · light')

		await open(page, '/workspace/settings')
		await expectNoButton(page, 'Add adapter')
		await expectNoButton(page, 'Add viewport')
		await expectNoButton(page, 'Add theme')
		await expectNoButton(page, 'Save settings')
		const enabledWorkspaceFields = await main(page).locator('input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), button[role="combobox"]:not([disabled])').count()
		if (enabledWorkspaceFields !== 0)
			throw new Error('Published Workspace settings still expose editable fields.')

		await open(page, '/workspace/locales')
		await expectNoButton(page, 'New Locale')
		await expectNoButton(page, 'Save')

		await open(page, '/workspace/assets')
		await expectNoButton(page, 'New Asset')
		await expectNoButton(page, 'Replace file')
		const assetDownload = main(page).getByRole('link', { name: 'Download' })
		await assetDownload.waitFor()
		const assetHref = await assetDownload.getAttribute('href')
		if (!assetHref?.includes('/uiux/_uiux/assets/'))
			throw new Error(`Published Asset download did not resolve to static content: ${assetHref}`)

		// /flows lists every Flow; open the first one.
		await open(page, '/flows')
		await main(page).locator('a[href*="/flows/"]').first().click()
		await page.waitForURL(/\/uiux\/flows\/[^/?]+/)
		await page.reload({ waitUntil: 'networkidle' })
		await main(page).waitFor()
		await expectNoButton(page, 'New Flow')
		await expectNoButton(page, 'Add step')
		await expectNoButton(page, 'Save Flow')

		await open(page, '/reviews')
		await expectNoButton(page, 'New thread')
		await expectNoButton(page, 'Comment')

		// Overview: per-View readiness from the published Workspace assessment, no export.
		await open(page, '/')
		await main(page).locator('[data-readiness]').first().waitFor()
		await expectNoButton(page, 'Export handoff…')

		// A View's Readiness tab: Evidence contact sheet from static artifacts, no capture or export.
		const viewKey = snapshot.resources.view[0].key
		await open(page, `/views/${viewKey}?panel=readiness`)
		const readiness = page.locator('[data-readiness-tab]')
		await readiness.locator('[data-readiness-badge]').waitFor()
		if (await page.locator('[data-capture-open], [data-capture-stale], [data-export-open]').count() !== 0)
			throw new Error('Published viewer exposed Evidence capture or Handoff export.')
		const evidenceImage = readiness.locator('[data-evidence-sheet] img').first()
		await evidenceImage.waitFor({ state: 'attached' })
		const evidenceSrc = await evidenceImage.getAttribute('src')
		if (!evidenceSrc?.includes('/uiux/_uiux/artifacts/'))
			throw new Error(`Published Evidence screenshot did not resolve to a static artifact: ${evidenceSrc}`)
		await readiness.locator('[data-facet="handoff"]').getByText('implementation-ready', { exact: true }).waitFor()

		// No version history is published: the Activity tab says so and offers no timeline, and a
		// Preview frame addressed to a version says the snapshot has none instead of fetching it.
		await open(page, '/?tab=activity')
		await main(page).getByText('A published snapshot has no version history.', { exact: true }).first().waitFor()
		if (await page.locator('[data-history-filters], [data-create-checkpoint]').count() !== 0)
			throw new Error('Published viewer exposed the version timeline.')
		await page.goto(`${origin}/uiux/preview?viewId=${encodeURIComponent(viewKey)}&version=${encodeURIComponent(versionIds[0])}`, { waitUntil: 'networkidle' })
		await page.locator('[data-preview-status="error"]').getByText('A published snapshot has no version history, so this version can\'t be shown.', { exact: true }).waitFor()

		await page.waitForTimeout(200)
		const runtimeApiRequests = requests.filter((requestUrl) => {
			const url = new URL(requestUrl)
			return url.origin === server.origin && url.pathname.includes('/api/')
		})
		const remoteIconRequests = requests.filter(requestUrl => requestUrl.includes('api.iconify.design'))
		if (runtimeApiRequests.length)
			throw new Error(`Published viewer made runtime API requests:\n${runtimeApiRequests.join('\n')}`)
		if (remoteIconRequests.length)
			throw new Error(`Published viewer fetched icons from Iconify at runtime:\n${remoteIconRequests.join('\n')}`)
		if (consoleProblems.length || pageErrors.length)
			throw new Error(`Published viewer emitted browser errors:\n${[...consoleProblems, ...pageErrors].join('\n')}`)
	}
	finally {
		await browser.close()
		await server.close()
	}

	console.log(`Publication browser smoke passed: ${snapshot.publicationIdentity}; none of ${historyCheck.versions} recorded versions reached its ${historyCheck.files} files.`)
}
finally {
	await rm(tempRoot, { recursive: true, force: true })
	await rm(workspaceCopy, { recursive: true, force: true })
	await rm(uiuxHome, { recursive: true, force: true })
}
