import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, stat, writeFile, cp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUTPUT_MARKER = '.uiux-publication-output'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function base32(bytes) {
	let bits = 0
	let value = 0
	let output = ''
	for (const byte of bytes) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			output += BASE32[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) output += BASE32[(value << (5 - bits)) & 31]
	return output
}

/**
 * The per-run `system:publish` credential (accepted identity decision 1): random, in memory only,
 * handed to the internal server child through its environment and sent as a bearer token on the
 * internal read requests. It has the fixed credential shape so log redaction always catches it.
 */
function createPublishCredential() {
	return `uiux_s_${base32(randomBytes(3)).slice(0, 4)}_${base32(randomBytes(7)).slice(0, 10)}_${base32(randomBytes(32))}`
}

export function parsePublishArguments(args) {
	const options = {
		workspace: undefined,
		out: undefined,
		base: '/',
		sourceRevision: undefined,
	}
	for (let index = 0; index < args.length; index += 1) {
		const name = args[index]
		if (!['--workspace', '--out', '--base', '--source-revision'].includes(name))
			return undefined
		const value = args[index + 1]
		if (!value) return undefined
		index += 1
		if (name === '--workspace') options.workspace = value
		else if (name === '--out') options.out = value
		else if (name === '--base') options.base = value
		else options.sourceRevision = value
	}
	if (!options.workspace || !options.out) return undefined
	return options
}

export async function runPublish(options, packageRoot) {
	const workspaceRoot = resolve(process.cwd(), options.workspace)
	const outputRoot = resolve(process.cwd(), options.out)
	const base = normalizeBase(options.base)

	await assertWorkspace(workspaceRoot)
	const [canonicalWorkspaceRoot, canonicalOutputRoot, canonicalPackageRoot] = await Promise.all([
		realpath(workspaceRoot),
		canonicalFuturePath(outputRoot),
		realpath(packageRoot),
	])
	assertSeparatePublicationPaths(canonicalWorkspaceRoot, canonicalOutputRoot, canonicalPackageRoot)
	await prepareOutput(outputRoot)

	const serverEntry = resolve(packageRoot, '.output/server/index.mjs')
	try {
		await stat(serverEntry)
	}
	catch {
		throw new Error('Packaged UIUX server is missing. Build @deviltea/uiux before running publish.')
	}

	const tempRoot = await mkdtemp(join(tmpdir(), 'uiux-publication-'))
	let server
	let activeChild
	let interruptedSignal
	const interrupt = (signal) => {
		interruptedSignal = signal
		if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null)
			activeChild.kill(signal)
		void server?.stop()
	}
	const onSigint = () => interrupt('SIGINT')
	const onSigterm = () => interrupt('SIGTERM')
	process.once('SIGINT', onSigint)
	process.once('SIGTERM', onSigterm)

	const credential = createPublishCredential()
	try {
		server = await startInternalServer({
			packageRoot,
			workspaceRoot,
			serverEntry,
			credential,
			onChild(child) { activeChild = child },
		})
		throwIfInterrupted(interruptedSignal)
		const snapshotUrl = server.origin + '/api/publication/snapshot'
			+ (options.sourceRevision ? '?sourceRevision=' + encodeURIComponent(options.sourceRevision) : '')
		const snapshot = await fetchJson(snapshotUrl, credential)
		throwIfInterrupted(interruptedSignal)

		await generateStaticShell({
			packageRoot,
			tempRoot,
			base,
			onChild(child) { activeChild = child },
		})
		throwIfInterrupted(interruptedSignal)
		const generatedPublic = join(tempRoot, 'nitro', 'public')
		await cp(generatedPublic, outputRoot, { recursive: true, force: true })
		throwIfInterrupted(interruptedSignal)

		await materializePublicationFiles({
			origin: server.origin,
			outputRoot,
			snapshot,
			credential,
		})
		throwIfInterrupted(interruptedSignal)

		const publicationDir = join(outputRoot, '_uiux')
		await mkdir(publicationDir, { recursive: true })
		await writeFile(join(publicationDir, 'publication.json'), JSON.stringify(snapshot) + '\n', 'utf8')
		await writeFile(
			join(outputRoot, OUTPUT_MARKER),
			JSON.stringify({
				schemaVersion: 1,
				publicationIdentity: snapshot.publicationIdentity,
				base,
			}, null, 2) + '\n',
			'utf8',
		)
		await writeFile(join(outputRoot, '.nojekyll'), '', 'utf8')

		try {
			await stat(join(outputRoot, 'preview', 'index.html'))
		}
		catch {
			throw new Error('Static UIUX shell did not generate the required /preview entry point.')
		}

		console.log('Published UIUX Workspace snapshot')
		console.log('  workspace: ' + workspaceRoot)
		console.log('  output:    ' + outputRoot)
		console.log('  base:      ' + base)
		console.log('  identity:  ' + snapshot.publicationIdentity)
	}
	finally {
		process.off('SIGINT', onSigint)
		process.off('SIGTERM', onSigterm)
		if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null)
			activeChild.kill('SIGTERM')
		await server?.stop()
		await rm(tempRoot, { recursive: true, force: true })
	}
}

function normalizeBase(input) {
	let base = input || '/'
	if (/^[a-z][a-z0-9+.-]*:/iu.test(base) || base.includes('?') || base.includes('#') || base.includes('\\'))
		throw new Error('Publication base must be a URL path such as / or /uiux/.')
	if (!base.startsWith('/')) base = '/' + base
	const segments = base.split('/').filter(Boolean)
	if (segments.some(segment => segment === '.' || segment === '..'))
		throw new Error('Publication base must not contain dot path segments.')
	base = '/' + segments.join('/')
	if (base !== '/') base += '/'
	return base
}

async function assertWorkspace(workspaceRoot) {
	let workspaceStat
	try {
		workspaceStat = await stat(workspaceRoot)
	}
	catch {
		throw new Error('Workspace root does not exist: ' + workspaceRoot)
	}
	if (!workspaceStat.isDirectory())
		throw new Error('Workspace root is not a directory: ' + workspaceRoot)
	try {
		await stat(join(workspaceRoot, '.uiux', 'workspace.json'))
	}
	catch {
		throw new Error('Workspace is not initialized: ' + workspaceRoot)
	}
}

export function assertSeparatePublicationPaths(workspaceRoot, outputRoot, packageRoot) {
	if (isSameOrDescendant(workspaceRoot, outputRoot) || isSameOrDescendant(outputRoot, workspaceRoot))
		throw new Error('Publication output and Workspace must be separate, non-overlapping directories.')
	if (packageRoot && isSameOrDescendant(outputRoot, packageRoot))
		throw new Error('Publication output must not be the UIUX package root or an ancestor of it.')
}

function isSameOrDescendant(parent, candidate) {
	const rel = relative(parent, candidate)
	return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep))
}

async function canonicalFuturePath(path) {
	try {
		return await realpath(path)
	}
	catch (error) {
		if (error?.code !== 'ENOENT') throw error
		const parent = dirname(path)
		if (parent === path) throw error
		return join(await canonicalFuturePath(parent), basename(path))
	}
}

async function prepareOutput(outputRoot) {
	try {
		const outputStat = await lstat(outputRoot)
		if (outputStat.isSymbolicLink() || !outputStat.isDirectory())
			throw new Error('Publication output must be a real directory: ' + outputRoot)
		const entries = await readdir(outputRoot)
		if (entries.length > 0 && !entries.includes(OUTPUT_MARKER))
			throw new Error('Refusing to replace a non-empty directory that was not created by uiux publish: ' + outputRoot)
		if (entries.length > 0)
			await Promise.all(entries.map(entry => rm(join(outputRoot, entry), { recursive: true, force: true })))
	}
	catch (error) {
		if (error?.code !== 'ENOENT') throw error
	}
	await mkdir(outputRoot, { recursive: true })
}

async function getAvailablePort() {
	return await new Promise((resolvePort, reject) => {
		const server = createServer()
		server.unref()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address ? address.port : undefined
			server.close(error => {
				if (error) reject(error)
				else if (!port) reject(new Error('Could not allocate an internal publication port.'))
				else resolvePort(port)
			})
		})
	})
}

async function startInternalServer({ packageRoot, workspaceRoot, serverEntry, credential, onChild }) {
	const port = await getAvailablePort()
	const origin = 'http://127.0.0.1:' + port
	let stderr = ''
	const child = spawn(process.execPath, [serverEntry], {
		cwd: packageRoot,
		stdio: ['ignore', 'ignore', 'pipe'],
		env: {
			...process.env,
			UIUX_WORKSPACE_ROOT: workspaceRoot,
			UIUX_PACKAGE_ROOT: packageRoot,
			NITRO_HOST: '127.0.0.1',
			NITRO_PORT: String(port),
			PORT: String(port),
			// The internal server keeps an in-memory roster and accepts only this read-only credential.
			UIUX_INTERNAL_PUBLISH_CREDENTIAL: credential,
		},
	})
	onChild?.(child)
	child.stderr?.on('data', chunk => {
		stderr = (stderr + String(chunk)).slice(-12000)
	})

	try {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (child.exitCode !== null)
				throw new Error('Internal UIUX server exited before publication materialization. ' + stderr.trim())
			try {
				const response = await fetch(origin + '/api/health')
				if (response.ok) {
					return {
						origin,
						async stop() {
							if (child.exitCode === null) {
								child.kill('SIGTERM')
								await waitForExit(child, 5000)
							}
						},
					}
				}
			}
			catch {
				// retry while packaged server starts
			}
			await sleep(50)
		}
		throw new Error('Timed out waiting for the internal UIUX publication server. ' + stderr.trim())
	}
	catch (error) {
		if (child.exitCode === null) child.kill('SIGTERM')
		await waitForExit(child, 2000)
		throw error
	}
}

async function generateStaticShell({ packageRoot, tempRoot, base, onChild }) {
	const nuxtPackagePath = fileURLToPath(import.meta.resolve('nuxt/package.json'))
	const nuxtPackageDir = dirname(nuxtPackagePath)
	const nuxtCli = resolve(nuxtPackageDir, 'bin', 'nuxt.mjs')
	const outputDir = join(tempRoot, 'nitro')
	const child = spawn(process.execPath, [nuxtCli, 'generate'], {
		cwd: packageRoot,
		stdio: 'inherit',
		env: {
			...process.env,
			UIUX_PUBLICATION_MODE: '1',
			UIUX_APP_BASE_URL: base,
			UIUX_NITRO_OUTPUT_DIR: outputDir,
			NODE_PATH: nuxtNodePath(nuxtPackageDir),
		},
	})
	onChild?.(child)
	const result = await waitForChild(child)
	await cleanupGeneratedDistLink(packageRoot, join(outputDir, 'public'))
	if (result.error) throw result.error
	if (result.signal || result.code !== 0)
		throw new Error('Nuxt static publication build failed.')
}

async function cleanupGeneratedDistLink(packageRoot, generatedPublic) {
	const distPath = join(packageRoot, 'dist')
	try {
		const distStat = await lstat(distPath)
		if (!distStat.isSymbolicLink()) return
		const target = await readlink(distPath)
		if (resolve(dirname(distPath), target) === resolve(generatedPublic))
			await rm(distPath)
	}
	catch (error) {
		if (error?.code !== 'ENOENT') throw error
	}
}

function nuxtNodePath(nuxtPackageDir) {
	const candidates = [
		join(nuxtPackageDir, 'node_modules'),
		dirname(nuxtPackageDir),
	]
	const pnpmMarker = sep + '.pnpm' + sep
	const markerIndex = nuxtPackageDir.indexOf(pnpmMarker)
	if (markerIndex >= 0) {
		const pnpmRoot = nuxtPackageDir.slice(0, markerIndex) + sep + '.pnpm'
		candidates.push(join(pnpmRoot, 'node_modules'))
	}
	if (process.env.NODE_PATH) candidates.push(process.env.NODE_PATH)
	return [...new Set(candidates)].join(delimiter)
}

async function materializePublicationFiles({ origin, outputRoot, snapshot, credential }) {
	if (snapshot?.preview?.state === 'valid') {
		await fetchToFile(
			origin + '/api/preview/runtime?v=' + encodeURIComponent(snapshot.preview.hash),
			join(outputRoot, snapshot.preview.runtimeFile),
			credential,
		)
	}
	for (const [assetId, entry] of Object.entries(snapshot?.files?.assets || {})) {
		await fetchToFile(
			origin + '/api/assets/' + encodeURIComponent(assetId) + '/content',
			join(outputRoot, entry.file),
			credential,
		)
	}
	for (const [digest, entry] of Object.entries(snapshot?.files?.artifacts || {})) {
		await fetchToFile(
			origin + '/api/artifacts/' + encodeURIComponent(digest),
			join(outputRoot, entry.file),
			credential,
		)
	}
}

async function fetchJson(url, credential) {
	const response = await fetch(url, { headers: { authorization: 'Bearer ' + credential } })
	if (!response.ok) {
		const body = await response.text()
		throw new Error('Publication snapshot request failed (' + response.status + '): ' + body)
	}
	return await response.json()
}

async function fetchToFile(url, path, credential) {
	const response = await fetch(url, { headers: { authorization: 'Bearer ' + credential } })
	if (!response.ok)
		throw new Error('Publication file request failed (' + response.status + '): ' + url)
	const bytes = new Uint8Array(await response.arrayBuffer())
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, bytes)
}

function waitForChild(child) {
	return new Promise(resolveExit => {
		child.once('error', error => resolveExit({ error }))
		child.once('exit', (code, signal) => resolveExit({ code, signal }))
	})
}

async function waitForExit(child, timeoutMs) {
	if (child.exitCode !== null || child.signalCode !== null) return
	await Promise.race([waitForChild(child), sleep(timeoutMs)])
	if (child.exitCode === null && child.signalCode === null)
		child.kill('SIGKILL')
}

function throwIfInterrupted(signal) {
	if (signal) throw new Error(`UIUX publication interrupted by ${signal}.`)
}

function sleep(ms) {
	return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}
