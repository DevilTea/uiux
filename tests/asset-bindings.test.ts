import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
	bindsChangedAsset,
	collectBoundAssetIds,
	liveAssetContentUrl,
	resolveAssetTarget,
	versionAssetContentUrl,
	type AssetResolutionTable,
} from '../src/assets'
import { createViewAssetBindingCheck } from '../src/application/services/asset-bindings'
import type { AdapterWidgetCatalogEntry } from '../src/domain/adapters/schema'
import { assetMediaTypeCategory, validateAssetBindingCompatibility, type AuthoredAssetResource } from '../src/domain/assets/schema'
import type { JsonValue } from '../src/domain/validation'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { assetBindingDiagnostics, buildEffectiveViewSource } from '../src/runtime/effective-view-source'
import { readAssetContentForHttp } from '../src/server/authoring-http'
import { MAX_PREVIEW_ASSET_IDS, resolvePreviewAssetsForHttp } from '../src/server/preview-assets-http'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * `$asset` bindings in Views (issue #97; Discussion #241 owner rulings 2026-10-23): the runtime value a
 * Widget's Config receives (Clause 01a167f4-3e4e-7af1-b328-30fb52f7f4c5) and its URL (Clause
 * 01a167f4-401d-7330-ac65-0a900adbccd6), category matching (Clause 01a167f4-43a6-772b-9304-410708912c4e),
 * the digest check on Asset content (Clause 01a167f4-41f2-70a1-a200-a005d47b12b5), and the diagnostics that
 * keep a View with an invalid binding from rendering (Rules 01a115cd-c06c-730f-a979-2491cadfb238,
 * 01a115cd-c09f-7018-9f52-48b05284f600, 01a115cd-c0d2-7427-8a95-927b2b3518c9 and 01a115cd-c106-71d6-b1f8-4d59cab22ad2).
 */

const ASSET_ID = '55555555-5555-4555-8555-555555555555'
const OTHER_ID = '66666666-6666-4666-8666-666666666666'
const DIGEST = `sha256:${'a'.repeat(64)}`
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])

const CATALOG = new Map<string, AdapterWidgetCatalogEntry>([
	['Picture', { assetFields: { src: { acceptedCategories: ['image'] }, poster: { acceptedMediaTypes: ['image/png'] } } }],
	['Panel', {}],
])

function readyTable(mediaType = 'image/png', id = ASSET_ID): AssetResolutionTable {
	return { [id]: { state: 'ready', value: { url: liveAssetContentUrl(id, DIGEST), mediaType, contentDigest: DIGEST } } }
}

function view(config: Record<string, JsonValue>, type = 'Picture'): JsonValue {
	return { type: 'RootShell', id: 'root', slots: { content: [{ id: 'panel', type: 'Panel', slots: { content: [{ id: 'pic', type, config }] } }] } }
}

function pictureConfig(source: JsonValue): JsonValue {
	const root = source as { slots: { content: [{ slots: { content: [{ config: JsonValue }] } }] } }
	return root.slots.content[0].slots.content[0].config
}

const temporaryRoots: string[] = []
afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('the effective View source of a View that binds Assets', () => {
	it('gives the Widget the resolved runtime value under the same field, frozen, and leaves the authored View alone', () => {
		const authored = view({ src: { $asset: ASSET_ID }, alt: 'Logo', caption: { note: 'not a binding' } })
		const before = JSON.stringify(authored)
		const result = buildEffectiveViewSource(authored, CATALOG, readyTable())
		expect(result.state).toBe('ready')
		if (result.state !== 'ready') return
		const config = pictureConfig(result.source) as Record<string, unknown>
		expect(config.src).toEqual({ url: `/api/assets/${ASSET_ID}/content?digest=${DIGEST}`, mediaType: 'image/png', contentDigest: DIGEST })
		expect(Object.isFrozen(config.src)).toBe(true)
		// Other Config values, an object without `$asset` included, are never taken for a reference.
		expect(config.alt).toBe('Logo')
		expect(config.caption).toEqual({ note: 'not a binding' })
		expect(JSON.stringify(authored)).toBe(before)
	})

	it('refuses a binding in a field the Catalog does not declare asset-capable', () => {
		const result = buildEffectiveViewSource(view({ title: { $asset: ASSET_ID } }), CATALOG, readyTable())
		expect(result).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'asset.field_not_capable', path: '/ir/slots/content/0/slots/content/0/config/title' }] })
	})

	it('refuses a binding to a missing or invalid Asset at the binding, with the server\'s diagnostics, and substitutes nothing', () => {
		const missing = buildEffectiveViewSource(view({ src: { $asset: ASSET_ID } }), CATALOG, {
			[ASSET_ID]: { state: 'blocked', diagnostics: [{ code: 'asset.missing_reference', path: '', message: `Referenced authored Asset ${ASSET_ID} does not exist.` }] },
		})
		expect(missing).toEqual({ state: 'invalid', diagnostics: [{ code: 'asset.missing_reference', path: '/ir/slots/content/0/slots/content/0/config/src/$asset', message: `Referenced authored Asset ${ASSET_ID} does not exist.` }] })

		const corrupt = buildEffectiveViewSource(view({ src: { $asset: ASSET_ID } }), CATALOG, {
			[ASSET_ID]: { state: 'blocked', diagnostics: [{ code: 'asset.signature_media_type_mismatch', path: '/metadata/mediaType', message: 'mismatch' }] },
		})
		expect(corrupt).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'asset.signature_media_type_mismatch', path: '/ir/slots/content/0/slots/content/0/config/src/$asset' }] })
	})

	it('refuses a binding the server did not resolve', () => {
		const result = buildEffectiveViewSource(view({ src: { $asset: OTHER_ID } }), CATALOG, readyTable())
		expect(result).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'asset.unresolved_reference', path: '/ir/slots/content/0/slots/content/0/config/src/$asset' }] })
		// No table at all resolves nothing either.
		expect(buildEffectiveViewSource(view({ src: { $asset: OTHER_ID } }), CATALOG)).toMatchObject({ state: 'invalid' })
	})

	it('refuses an Asset whose media type and category the field does not accept', () => {
		const pdf = buildEffectiveViewSource(view({ src: { $asset: ASSET_ID } }), CATALOG, readyTable('application/pdf'))
		expect(pdf).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'asset.incompatible_media_type', path: '/ir/slots/content/0/slots/content/0/config/src' }] })
		const jpeg = buildEffectiveViewSource(view({ poster: { $asset: ASSET_ID } }), CATALOG, readyTable('image/jpeg'))
		expect(jpeg).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'asset.incompatible_media_type', path: '/ir/slots/content/0/slots/content/0/config/poster' }] })
	})

	it('refuses a malformed binding before looking it up', () => {
		const result = buildEffectiveViewSource(view({ src: { $asset: ASSET_ID, fallback: 'logo.png' } }), CATALOG, readyTable())
		expect(result).toMatchObject({ state: 'invalid', diagnostics: [{ code: 'asset.invalid_binding_shape' }] })
	})
})

describe('category matching (Clause 01a167f4-43a6-772b-9304-410708912c4e)', () => {
	it('takes the top-level type of the media type as the category', () => {
		expect(assetMediaTypeCategory('image/png')).toBe('image')
		expect(assetMediaTypeCategory('Image/SVG+XML')).toBe('image')
		expect(validateAssetBindingCompatibility('image/svg+xml', { acceptedCategories: ['image'] }).ok).toBe(true)
		expect(validateAssetBindingCompatibility('application/pdf', { acceptedCategories: ['image'] }).ok).toBe(false)
		expect(validateAssetBindingCompatibility('image/png', { acceptedMediaTypes: ['application/pdf'], acceptedCategories: ['image'] }).ok).toBe(true)
		expect(validateAssetBindingCompatibility('IMAGE/PNG', { acceptedMediaTypes: ['image/png'] }).ok).toBe(true)
	})
})

describe('the Assets a View binds', () => {
	it('are the `$asset` UUIDs of top-level Config members, at every slot depth', () => {
		const ir = view({ src: { $asset: OTHER_ID }, poster: { $asset: ASSET_ID }, alt: ASSET_ID, nested: { inner: { $asset: ASSET_ID } }, bad: { $asset: 'logo' } })
		expect(collectBoundAssetIds(ir)).toEqual([ASSET_ID, OTHER_ID])
		expect(collectBoundAssetIds(undefined)).toEqual([])
	})

	it('make a Preview resolve again only when one of them changes, or after a resync', () => {
		const ir = view({ src: { $asset: ASSET_ID } })
		expect(bindsChangedAsset(ir, { resync: false, changes: [{ kind: 'asset', key: ASSET_ID }] })).toBe(true)
		expect(bindsChangedAsset(ir, { resync: false, changes: [{ kind: 'asset', key: OTHER_ID }, { kind: 'view', key: ASSET_ID }] })).toBe(false)
		expect(bindsChangedAsset(ir, { resync: true, changes: [] })).toBe(true)
		expect(bindsChangedAsset(view({ alt: 'x' }), { resync: true, changes: [] })).toBe(false)
	})
})

describe('resolving an Asset for execution', () => {
	it('yields the runtime value with the URL form asked for, or blocks a missing Asset', async () => {
		const resource: AuthoredAssetResource = { metadata: { id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png' }, content: PNG }
		const digest = `sha256:${createHash('sha256').update(PNG).digest('hex')}`
		const live = await resolveAssetTarget({ assetId: ASSET_ID, lookup: { read: async () => ({ resource, diagnostics: [] }) }, url: liveAssetContentUrl })
		expect(live).toEqual({ state: 'ready', value: { url: `/api/assets/${ASSET_ID}/content?digest=${digest}`, mediaType: 'image/png', contentDigest: digest } })
		const version = await resolveAssetTarget({ assetId: ASSET_ID, lookup: { read: async () => ({ resource, diagnostics: [] }) }, url: (_id, contentDigest) => versionAssetContentUrl(contentDigest) })
		expect(version).toMatchObject({ state: 'ready', value: { url: `/api/history/blobs/${digest}` } })
		const missing = await resolveAssetTarget({ assetId: ASSET_ID, lookup: { read: async () => undefined }, url: liveAssetContentUrl })
		expect(missing).toMatchObject({ state: 'blocked', diagnostics: [{ code: 'asset.missing_reference' }] })
	})
})

describe('the server side', () => {
	async function workspaceWithAsset(adapters: readonly Readonly<{ moduleSpecifier: string }>[] = []): Promise<{ root: string; persistence: FileNativePersistence; digest: string }> {
		const root = await mkdtemp(join(tmpdir(), 'uiux-asset-bindings-'))
		temporaryRoots.push(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, adapters })
		await persistence.assets.create(ASSET_ID, { metadata: { id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png' }, content: PNG })
		return { root, persistence, digest: `sha256:${createHash('sha256').update(PNG).digest('hex')}` }
	}

	it('resolves the Preview\'s bound Assets from the inspected read: valid, missing and corrupt', async () => {
		const { root, persistence, digest } = await workspaceWithAsset()
		const ready = await resolvePreviewAssetsForHttp(persistence, `${ASSET_ID},${OTHER_ID},${ASSET_ID}`)
		expect(ready.status).toBe(200)
		expect(ready.body).toEqual({
			assets: {
				[ASSET_ID]: { state: 'ready', value: { url: `/api/assets/${ASSET_ID}/content?digest=${digest}`, mediaType: 'image/png', contentDigest: digest } },
				[OTHER_ID]: { state: 'blocked', diagnostics: [{ code: 'asset.missing_reference', path: '', message: `Referenced authored Asset ${OTHER_ID} does not exist.` }] },
			},
		})

		// A second content file makes the Asset invalid; an unreadable asset.json blocks it as well.
		await writeFile(join(root, 'assets', ASSET_ID, 'extra.bin'), 'extra')
		expect((await resolvePreviewAssetsForHttp(persistence, ASSET_ID)).body).toMatchObject({ assets: { [ASSET_ID]: { state: 'blocked', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'asset.invalid_content_file_count' })]) } } })
		await writeFile(join(root, 'assets', ASSET_ID, 'asset.json'), '{ not json')
		expect((await resolvePreviewAssetsForHttp(persistence, ASSET_ID)).body).toMatchObject({ assets: { [ASSET_ID]: { state: 'blocked', diagnostics: [expect.objectContaining({ code: expect.stringMatching(/^persistence\./u) })] } } })
	})

	it('refuses malformed or too many IDs and answers nothing for none', async () => {
		const { persistence } = await workspaceWithAsset()
		expect(await resolvePreviewAssetsForHttp(persistence, undefined)).toMatchObject({ status: 200, body: { assets: {} } })
		expect(await resolvePreviewAssetsForHttp(persistence, 'logo.png')).toMatchObject({ status: 400, body: { code: 'invalid_asset_ids' } })
		expect(await resolvePreviewAssetsForHttp(persistence, [ASSET_ID, ASSET_ID])).toMatchObject({ status: 400, body: { code: 'invalid_asset_ids' } })
		const tooMany = Array.from({ length: MAX_PREVIEW_ASSET_IDS + 1 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`).join(',')
		expect(await resolvePreviewAssetsForHttp(persistence, tooMany)).toMatchObject({ status: 400, body: { code: 'invalid_asset_ids' } })
	})

	it('checks a View\'s bindings for its diagnostics against the Catalog, or only their Assets while the Adapters cannot resolve (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c)', async () => {
		const ir = view({ src: { $asset: ASSET_ID }, poster: { $asset: OTHER_ID } })
		// No Adapter declares the field asset-capable, and OTHER_ID does not exist.
		const { persistence } = await workspaceWithAsset()
		const check = createViewAssetBindingCheck(persistence).check
		expect(await check(view({ alt: 'x' }))).toEqual([])
		expect((await check(ir)).map(item => [item.code, item.path])).toEqual([
			['asset.field_not_capable', '/ir/slots/content/0/slots/content/0/config/src'],
			['asset.field_not_capable', '/ir/slots/content/0/slots/content/0/config/poster'],
			['asset.missing_reference', '/ir/slots/content/0/slots/content/0/config/poster/$asset'],
		])

		const unresolvable = await workspaceWithAsset([{ moduleSpecifier: './adapters/missing.mjs' }])
		expect((await createViewAssetBindingCheck(unresolvable.persistence).check(ir)).map(item => item.code)).toEqual(['asset.missing_reference'])
	})

	it('diagnoses bindings as a render would, without the Catalog when it is unknown', () => {
		const ir = view({ src: { $asset: ASSET_ID }, title: { $asset: ASSET_ID } })
		expect(assetBindingDiagnostics(ir, CATALOG, readyTable()).map(item => item.code)).toEqual(['asset.field_not_capable'])
		expect(assetBindingDiagnostics(ir, undefined, readyTable())).toEqual([])
		expect(assetBindingDiagnostics(ir, undefined, {}).map(item => item.code)).toEqual(['asset.unresolved_reference', 'asset.unresolved_reference'])
	})

	it('serves Asset content for its current digest only (Clause 01a167f4-41f2-70a1-a200-a005d47b12b5)', async () => {
		const { persistence, digest } = await workspaceWithAsset()
		// The plain URL follows replacements, so it is never stored; a digest-qualified one is revalidated by an ETag
		// that covers the metadata its headers come from, so a metadata-only change is not served stale.
		expect(await readAssetContentForHttp(persistence, ASSET_ID)).toMatchObject({ status: 200, body: PNG, headers: { 'Cache-Control': 'no-store' } })
		expect(await readAssetContentForHttp(persistence, ASSET_ID, digest)).toMatchObject({ status: 200, body: PNG, headers: { 'Cache-Control': 'private, no-cache', 'X-Content-Type-Options': 'nosniff' } })
		const etag = (await readAssetContentForHttp(persistence, ASSET_ID, digest)).headers?.ETag
		expect(etag).toMatch(/^"r_/)
		expect(await readAssetContentForHttp(persistence, ASSET_ID, digest, etag)).toMatchObject({ status: 304, headers: { 'Cache-Control': 'private, no-cache' } })
		expect(await readAssetContentForHttp(persistence, ASSET_ID, digest, '"r_other"')).toMatchObject({ status: 200 })
		// A metadata-only change keeps the digest URL but changes the ETag, so its new headers are fetched.
		const cas = await persistence.assets.compareAndSwap({ key: ASSET_ID, expectedRevision: (await persistence.assets.readInspected(ASSET_ID))!.revision, resource: { metadata: { id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/webp' }, content: PNG } })
		expect(cas.ok).toBe(true)
		const renamed = await readAssetContentForHttp(persistence, ASSET_ID, digest, etag)
		expect(renamed).toMatchObject({ status: 200, headers: { 'Content-Type': 'image/webp' } })
		expect(renamed.headers?.ETag).not.toBe(etag)
		// A matching ETag never bypasses the digest check.
		expect(await readAssetContentForHttp(persistence, ASSET_ID, DIGEST, renamed.headers?.ETag)).toMatchObject({ status: 409 })
		expect(await readAssetContentForHttp(persistence, ASSET_ID, DIGEST)).toMatchObject({ status: 409, body: { code: 'asset_content_digest_mismatch' } })
		expect(await readAssetContentForHttp(persistence, ASSET_ID, 'sha256:ABC')).toMatchObject({ status: 400, body: { code: 'invalid_asset_digest' } })
		expect(await readAssetContentForHttp(persistence, ASSET_ID, '')).toMatchObject({ status: 400, body: { code: 'invalid_asset_digest' } })
	})
})
