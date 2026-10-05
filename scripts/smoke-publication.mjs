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

async function nav(page, name) {
	const button = page.locator('aside').first().getByRole('button', { name: new RegExp(`^${name}`) }).first()
	await button.click()
}

async function expectNoButton(page, name) {
	const count = await page.locator('aside').first().getByRole('button', { name }).count()
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

		await page.goto(`${server.origin}/uiux/`, { waitUntil: 'networkidle' })
		await page.getByText('published · read-only', { exact: true }).waitFor()

		const frame = page.frames().find(candidate => candidate.url().includes('/uiux/preview?'))
		if (!frame) throw new Error('Published Workbench did not open the Preview iframe.')
		await frame.getByText('#root', { exact: true }).waitFor()
		await frame.getByText('en-US · dark', { exact: true }).waitFor()

		const themeSelect = page.locator('header select').last()
		await themeSelect.selectOption('light')
		await frame.getByText('en-US · light', { exact: true }).waitFor()

		await nav(page, 'Workspace')
		await expectNoButton(page, '+ Add Adapter')
		await expectNoButton(page, '+ Add Viewport')
		await expectNoButton(page, '+ Add Theme')
		await expectNoButton(page, 'Save Settings')
		const enabledWorkspaceFields = await page.locator('aside').first().locator('input:not([disabled]), textarea:not([disabled]), select:not([disabled])').evaluateAll(elements =>
			elements.filter(element => element.getAttribute('placeholder') !== 'Filter views…').length,
		)
		if (enabledWorkspaceFields !== 0)
			throw new Error('Published Workspace settings still expose editable fields.')

		await nav(page, 'Locales')
		await expectNoButton(page, '+ New Locale')
		await expectNoButton(page, 'Save Changes')

		await nav(page, 'Assets')
		await expectNoButton(page, '+ New Asset')
		await expectNoButton(page, 'Replace Asset Content')
		const assetDownload = page.locator('aside').first().getByRole('link', { name: '↓ Download' })
		await assetDownload.waitFor()
		const assetHref = await assetDownload.getAttribute('href')
		if (!assetHref?.includes('/uiux/_uiux/assets/'))
			throw new Error(`Published Asset download did not resolve to static content: ${assetHref}`)

		await nav(page, 'Flows')
		await expectNoButton(page, '+ New Flow')
		await expectNoButton(page, '+ Add Step')
		await expectNoButton(page, 'Save Flow Changes')

		await nav(page, 'Reviews')
		await expectNoButton(page, '+ Thread')
		await expectNoButton(page, '🎯 Comment')

		await nav(page, 'Evidence')
		await expectNoButton(page, 'Capture Active')
		const evidenceImage = page.locator('aside').first().locator('img[alt="Formal Capture Screenshot"]')
		await evidenceImage.waitFor()
		const evidenceSrc = await evidenceImage.getAttribute('src')
		if (!evidenceSrc?.includes('/uiux/_uiux/artifacts/'))
			throw new Error(`Published Evidence screenshot did not resolve to a static artifact: ${evidenceSrc}`)

		await nav(page, 'Handoff')
		await expectNoButton(page, 'Re-Assess')
		await expectNoButton(page, 'Export Snapshot')
		await page.locator('aside').first().getByText('Implementation Ready', { exact: true }).waitFor()
		await page.locator('aside').first().getByText('Claim Verified', { exact: true }).waitFor()

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
