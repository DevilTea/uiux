import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createThumbnailCapturer } from '../src/application/services/thumbnail-capture'
import { createThumbnailInputs } from '../src/application/services/thumbnail-inputs'
import type { AdapterProvenanceSource } from '../src/application/services/adapter-provenance'
import { pngSize, thumbnailDigestHex, thumbnailHeight, thumbnailInputDigest, THUMBNAIL_WIDTH, type ThumbnailInputs } from '../src/domain/thumbnails/digest'
import type { ViewResource } from '../src/domain/views/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * The thumbnail input digest (Clause 01a19b99-ccfa-74bb-9671-08ab5d4e2656) and the default context
 * (Rule 01a19b99-cfcc-7abb-8be5-75c2cc6e7148) read from a real Workspace.
 */
const VIEW = '11111111-1111-4111-8111-111111111111'
const ASSET = '33333333-3333-4333-8333-333333333333'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])

function view(overrides: Partial<ViewResource> = {}): ViewResource {
	return {
		id: VIEW,
		name: 'Checkout',
		feature: 'pay',
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Text', id: 'text-1', props: { value: 'Pay' }, bindings: {}, events: {} }] } },
		variants: { empty: { state: {}, requirements: [] } },
		spec: { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
		...overrides,
	} as ViewResource
}

let root: string
let persistence: FileNativePersistence
let adapterSource: AdapterProvenanceSource | undefined

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-thumbnail-inputs-')))
	await writeCurrentWorkspace(root, {
		i18n: { defaultLocale: 'en-US' },
		viewports: { desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } }, mobile: { label: 'Mobile', dimensions: { width: 375, height: 667 } } },
		themes: { dark: { label: 'Dark' }, light: { label: 'Light' } },
	})
	persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.locales.create('en-US', {})
	await persistence.views.create(VIEW, view())
	adapterSource = undefined
})
afterEach(() => rm(root, { recursive: true, force: true }))

const inputs = () => createThumbnailInputs(persistence, { ...(adapterSource ? { adapterProvenance: adapterSource } : {}) })
const digestOfView = async () => (await inputs().plans([VIEW]))[0]!.digest

async function change<R>(repository: { read(key: string): Promise<{ resource: R; revision: string } | undefined>; compareAndSwap(input: { key: string; expectedRevision: never; resource: R }): Promise<unknown> }, key: string, mutate: (resource: R) => R): Promise<void> {
	const read = (await repository.read(key))!
	await repository.compareAndSwap({ key, expectedRevision: read.revision as never, resource: mutate(structuredClone(read.resource)) })
}

describe('the default context (Rule 01a19b99-cfcc-7abb-8be5-75c2cc6e7148)', () => {
	it('is the base render in the default Locale, the widest viewport preset and the first theme by id', async () => {
		const [plan] = await inputs().plans([VIEW])
		expect(plan!.context).toEqual({ viewId: VIEW, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'dark' })
		expect(plan!.context).not.toHaveProperty('variantName')
		expect(plan!.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
	})

	it('plans every readable View when none is named, and none for a name that is no View', async () => {
		expect((await inputs().plans()).map(plan => plan.key)).toEqual([VIEW])
		expect(await inputs().plans(['44444444-4444-4444-8444-444444444444'])).toEqual([])
		expect(await inputs().plans(['not-a-key'])).toEqual([])
	})
})

describe('the thumbnail input digest (Clause 01a19b99-ccfa-74bb-9671-08ab5d4e2656)', () => {
	it('is stable for unchanged inputs', async () => {
		expect(await digestOfView()).toBe(await digestOfView())
	})

	it('changes with the View\'s structure and with a Variant', async () => {
		const before = await digestOfView()
		await change(persistence.views as never, VIEW, (resource: ViewResource) => ({ ...resource, ir: { ...(resource.ir as object), slots: { content: [] } } as ViewResource["ir"] }))
		const afterStructure = await digestOfView()
		expect(afterStructure).not.toBe(before)
		await change(persistence.views as never, VIEW, (resource: ViewResource) => ({ ...resource, variants: { ...resource.variants, other: { state: {}, requirements: [] } } }))
		expect(await digestOfView()).not.toBe(afterStructure)
	})

	it('is unchanged by a Spec-only or metadata edit (the render-input digest ignores them)', async () => {
		const before = await digestOfView()
		await change(persistence.views as never, VIEW, (resource: ViewResource) => ({
			...resource,
			name: 'Renamed',
			feature: 'other',
			spec: { ...resource.spec, intent: 'Another intent', requirements: ['01a1144e-50dd-7000-8000-000000000000'] },
		}))
		expect(await digestOfView()).toBe(before)
	})

	it('changes with the default Locale\'s revision', async () => {
		const before = await digestOfView()
		await change(persistence.locales as never, 'en-US', (resource: Record<string, unknown>) => ({ ...resource, hello: 'Hello' }))
		expect(await digestOfView()).not.toBe(before)
	})

	it('changes with the default viewport preset and the first theme', async () => {
		let digest = await digestOfView()
		await change(persistence.workspace as never, 'workspace', (resource: { viewports: Record<string, { dimensions: { width: number; height: number } }> }) => ({ ...resource, viewports: { ...resource.viewports, desktop: { ...resource.viewports.desktop!, dimensions: { width: 1280, height: 900 } } } }))
		let next = await digestOfView()
		expect(next).not.toBe(digest)
		digest = next
		await change(persistence.workspace as never, 'workspace', (resource: { themes: Record<string, unknown> }) => ({ ...resource, themes: { ...resource.themes, aaa: { label: 'First' } } }))
		next = await digestOfView()
		expect(next).not.toBe(digest)
		expect((await inputs().plans([VIEW]))[0]!.context!.themeId).toBe('aaa')
	})

	it('changes with the Product Kit provenance', async () => {
		const before = await digestOfView()
		await change(persistence.productKit as never, 'product-kit', (resource: { styles: string[] }) => ({ ...resource, styles: ['./dist/x.css'] }))
		expect(await digestOfView()).not.toBe(before)
	})

	it('changes with the Adapter provenance, and is not computable while it is unavailable', async () => {
		const before = await digestOfView()
		adapterSource = { kitBuild: () => ({ state: 'building' }) }
		const [plan] = await inputs().plans([VIEW])
		expect(plan!.digest).toBeUndefined() // Clause 01a19b99-cd8b-7a8d-a357-5a55fa9453d7 and Rule 01a19b99-d6a9-7208-912e-f154133e553b
		expect(plan!.context).toBeDefined()
		adapterSource = { kitBuild: () => ({ state: 'ready' }) }
		expect(await digestOfView()).toBe(before)
	})

	it('changes with the id and the revision of a bound Asset', async () => {
		const unbound = await digestOfView()
		await persistence.assets.create(ASSET, { metadata: { id: ASSET, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png' }, content: PNG_BYTES } as never)
		await change(persistence.views as never, VIEW, (resource: ViewResource) => ({
			...resource,
			ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Text', id: 'text-1', props: {}, config: { source: { $asset: ASSET } }, bindings: {}, events: {} }] } },
		} as never))
		const bound = await digestOfView()
		expect(bound).not.toBe(unbound)
		expect(bound).toBeDefined()
		const read = (await persistence.assets.read(ASSET))!
		await persistence.assets.compareAndSwap({ key: ASSET, expectedRevision: read.revision, resource: { ...read.resource, metadata: { ...read.resource.metadata, name: 'Logo 2' } } } as never)
		const replaced = await digestOfView()
		expect(replaced).toBeDefined()
		expect(replaced).not.toBe(bound)
	})

	it('cannot be computed without the default Locale\'s file', async () => {
		await rm(join(root, '.uiux', 'i18n', 'en-US.json'), { force: true })
		await rm(join(root, 'i18n', 'en-US.json'), { force: true })
		expect((await inputs().plans([VIEW]))[0]!.digest).toBeUndefined()
		expect(await inputs().defaultLocaleMissing()).toBe(true)
	})

	it('resolves the default Locale the same way for the hold and the digest when the manifest names none', async () => {
		const other = await realpath(await mkdtemp(join(tmpdir(), 'uiux-thumbnail-inputs-nolocale-')))
		try {
			await writeCurrentWorkspace(other, { i18n: undefined, viewports: {}, themes: {} })
			const bare = new FileNativePersistence({ root: other, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
			await bare.views.create(VIEW, view())
			// No Locale file: 'en-US' is the default for both, so the hold applies and no digest is computed.
			expect(await createThumbnailInputs(bare).defaultLocaleMissing()).toBe(true)
			expect((await createThumbnailInputs(bare).plans([VIEW]))[0]!.digest).toBeUndefined()
			await bare.locales.create('en-US', {})
			expect(await createThumbnailInputs(bare).defaultLocaleMissing()).toBe(false)
			expect((await createThumbnailInputs(bare).plans([VIEW]))[0]!.digest).toBeDefined()
		}
		finally { await rm(other, { recursive: true, force: true }) }
	})

	it('a closed capturer launches no browser (the service stopped)', async () => {
		const capturer = createThumbnailCapturer(persistence, { serverOrigin: 'http://127.0.0.1:9' })
		const [plan] = await inputs().plans([VIEW])
		await capturer.close(true)
		expect(await capturer.capture({ key: VIEW, context: plan!.context! })).toMatchObject({ ok: false, reason: expect.stringContaining('closed') })
	})
})

describe('the digest and image functions (Clauses 01a19b99-ccfa-… and 01a19b99-cc6d-…)', () => {
	const base: ThumbnailInputs = {
		renderInputDigest: 'sha256:abc',
		locale: { id: 'en-US', revision: 'r1' },
		viewport: { id: 'desktop', width: 1280, height: 800 },
		themeId: 'light',
		adapters: [],
		productKit: { dataDigest: 'x' },
		assets: {},
	}

	it.each([
		['renderInputDigest', { ...base, renderInputDigest: 'sha256:abd' }],
		['locale id', { ...base, locale: { ...base.locale, id: 'zh-TW' } }],
		['locale revision', { ...base, locale: { ...base.locale, revision: 'r2' } }],
		['viewport id', { ...base, viewport: { ...base.viewport, id: 'wide' } }],
		['viewport width', { ...base, viewport: { ...base.viewport, width: 1281 } }],
		['viewport height', { ...base, viewport: { ...base.viewport, height: 801 } }],
		['theme', { ...base, themeId: 'dark' }],
		['adapters', { ...base, adapters: [{ id: 'a' }] }],
		['product kit', { ...base, productKit: { dataDigest: 'y' } }],
		['assets', { ...base, assets: { [ASSET]: 'r1' } }],
	])('changes with its %s', (_name, changed) => {
		expect(thumbnailInputDigest(changed as ThumbnailInputs)).not.toBe(thumbnailInputDigest(base))
	})

	it('is sha256: and 64 hex digits, independent of key order', () => {
		const digest = thumbnailInputDigest(base)
		expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
		expect(thumbnailDigestHex(digest)).toHaveLength(64)
		expect(thumbnailInputDigest({ ...base, productKit: { b: 1, a: 2 } })).toBe(thumbnailInputDigest({ ...base, productKit: { a: 2, b: 1 } }))
	})

	it('sizes an image 480 px wide and 480 times the height over the width, rounded half up', () => {
		expect(THUMBNAIL_WIDTH).toBe(480)
		expect(thumbnailHeight({ width: 1280, height: 800 })).toBe(300)
		expect(thumbnailHeight({ width: 390, height: 844 })).toBe(1039) // 1038.77
		expect(thumbnailHeight({ width: 960, height: 1001 })).toBe(501) // 500.5 rounds up
		expect(thumbnailHeight({ width: 1000, height: 1001 })).toBe(480) // 480.48
	})

	it('reads the size of a PNG header', () => {
		expect(pngSize(PNG_BYTES)).toEqual({ width: 1, height: 1 })
		expect(pngSize(new Uint8Array([1, 2, 3]))).toBeUndefined()
	})
})
