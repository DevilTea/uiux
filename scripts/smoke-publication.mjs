#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const tempRoot = await mkdtemp(join(tmpdir(), 'uiux-publication-browser-'))
const publicationRoot = join(tempRoot, 'uiux')
const cli = join(process.cwd(), 'bin', 'uiux.mjs')

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
				response.writeHead(404)
				.end('Not found')
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

function activePanel(page) {
	return page.getByRole('tabpanel').first()
}

async function nav(page, name) {
	await page.getByRole('tablist').first().getByRole('tab', { name: new RegExp(`^${name}`) }).click()
	await activePanel(page).waitFor()
}

async function expectNoButton(page, name) {
	const count = await activePanel(page).getByRole('button', { name, exact: true }).count()
	if (count !== 0)
		throw new Error(`Published viewer exposed authoring button "${name}".`)
}

try {
	execFileSync(process.execPath, [
		cli,
		'publish',
		'--workspace', join(process.cwd(), 'design'),
		'--out', publicationRoot,
		'--base', '/uiux/',
		'--source-revision', 'publication-browser-smoke',
	], {
		stdio: 'pipe',
		timeout: 120_000,
	})

	const snapshot = JSON.parse(await readFile(join(publicationRoot, '_uiux', 'publication.json'), 'utf8'))
	if (snapshot.handoff?.readiness?.implementationReady !== true)
		throw new Error('Dogfood publication lost its Implementation Ready Handoff claim.')
	if (snapshot.preview?.state !== 'valid')
		throw new Error('Dogfood publication did not materialize a valid Preview adapter runtime.')

	const server = await startStaticServer()
	const browser = await chromium.launch({ headless: true })
	try {
		const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
		const consoleProblems = []
		const pageErrors = []
		const requests = []
		page.on('console', message => {
			if (message.type() === 'error' || message.type() === 'warning')
				consoleProblems.push(`${message.type()}: ${message.text()}`)
		})
		page.on('pageerror', error => pageErrors.push(error.message))
		page.on('request', request => requests.push(request.url()))

		await page.addInitScript(() => {
			// Pin the Workbench chrome locale so the English labels below are stable.
			localStorage.setItem('uiux.workbench.locale', 'en-US')
		})
		await page.goto(`${server.origin}/uiux/`, { waitUntil: 'networkidle' })
		await page.getByText('Published · read-only', { exact: true }).waitFor()

		const frame = page.frames().find(candidate => candidate.url().includes('/uiux/preview?'))
		if (!frame) throw new Error('Published Workbench did not open the Preview iframe.')
		await frame.locator('[data-preview-ready="true"]').waitFor()
		await page.getByText('en-US · dark · desktop', { exact: true }).waitFor()

		await page.getByRole('combobox', { name: 'Preview theme' }).click()
		await page.getByRole('option', { name: 'Light' }).click()
		await page.getByText('en-US · light · desktop', { exact: true }).waitFor()
		await page.waitForFunction(() => globalThis.document.querySelector('iframe')?.getAttribute('src')?.includes('themeId=light'))

		await nav(page, 'Workspace')
		await expectNoButton(page, 'Add adapter')
		await expectNoButton(page, 'Add viewport')
		await expectNoButton(page, 'Add theme')
		await expectNoButton(page, 'Save settings')
		const enabledWorkspaceFields = await activePanel(page).locator('input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), button[role="combobox"]:not([disabled])').count()
		if (enabledWorkspaceFields !== 0)
			throw new Error('Published Workspace settings still expose editable fields.')

		await nav(page, 'Locales')
		await expectNoButton(page, 'New locale')
		await expectNoButton(page, 'Save')

		await nav(page, 'Assets')
		await expectNoButton(page, 'New asset')
		await expectNoButton(page, 'Replace content')
		const assetDownload = activePanel(page).getByRole('link', { name: 'Download' })
		await assetDownload.waitFor()
		const assetHref = await assetDownload.getAttribute('href')
		if (!assetHref?.includes('/uiux/_uiux/assets/'))
			throw new Error(`Published Asset download did not resolve to static content: ${assetHref}`)

		await nav(page, 'Flows')
		await expectNoButton(page, 'New flow')
		await expectNoButton(page, 'Add step')
		await expectNoButton(page, 'Save flow')

		await nav(page, 'Reviews')
		await expectNoButton(page, 'New thread')
		await expectNoButton(page, 'Comment')
		if (await page.getByRole('button', { name: 'Comment', exact: true }).count() !== 0)
			throw new Error('Published viewer exposed the canvas Comment button.')

		await nav(page, 'Evidence')
		await expectNoButton(page, 'Capture active context')
		const evidenceImage = activePanel(page).locator('img[alt="Formal capture screenshot"]')
		await evidenceImage.waitFor()
		const evidenceSrc = await evidenceImage.getAttribute('src')
		if (!evidenceSrc?.includes('/uiux/_uiux/artifacts/'))
			throw new Error(`Published Evidence screenshot did not resolve to a static artifact: ${evidenceSrc}`)

		await nav(page, 'Handoff')
		await expectNoButton(page, 'Re-assess')
		await expectNoButton(page, 'Export snapshot')
		await activePanel(page).getByText('Implementation ready', { exact: true }).waitFor()

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

	console.log(`Publication browser smoke passed: ${snapshot.publicationIdentity}`)
}
finally {
	await rm(tempRoot, { recursive: true, force: true })
}
