import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createAssetService } from '../src/application/services/canonical-resources'
import { assetLookupFromInspectedSource, resolveAssetBindingForExecution } from '../src/assets'
import type { AuthoredAssetResource } from '../src/domain/assets/schema'
import { validateAdapterManifest } from '../src/domain/adapters/schema'
import type { I18nFieldMapping } from '../src/domain/i18n/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { lowerI18nBinding, createTranslationRuntime, inspectTranslationResources, inspectWorkspaceI18n, interpolateTemplate } from '../src/i18n'
import { FileNativePersistence, type PersistenceFaultPoint } from '../src/persistence'
import { defineWorkspaceSchemaPolicy } from '../src/persistence/schema-policy'

const ASSET_ID = '44444444-4444-4444-8444-444444444444'
const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('i18n runtime and Checks semantics', () => {
	it('distinguishes missing translation fallback, unresolved keys, and missing parameters in canonical warning order', () => {
		const resources = new Map([
			['en-US', { greeting: 'Hello {name} from {place}' }],
			['zh-TW', {}],
		])
		const state = createTranslationRuntime('en-US', resources)
		expect(state.state).toBe('ready')
		if (state.state !== 'ready') return

		const fallback = state.runtime.translate('zh-TW', 'greeting', { name: '威任' })
		expect(fallback.text).toBe('Hello 威任 from ⟦missing-param:place⟧')
		expect(fallback.warnings).toEqual([
			{ code: 'missing-translation', key: 'greeting', requestedLocale: 'zh-TW', fallbackLocale: 'en-US' },
			{ code: 'missing-parameter', key: 'greeting', requestedLocale: 'zh-TW', parameter: 'place' },
		])

		const unresolved = state.runtime.translate('zh-TW', 'unknown')
		expect(unresolved).toEqual({
			text: '⟦missing:unknown⟧',
			warnings: [{ code: 'unresolved-key', key: 'unknown', requestedLocale: 'zh-TW' }],
		})
	})

	it('renders unresolved keys containing placeholder-like braces verbatim without parameter warnings', () => {
		const state = createTranslationRuntime('en-US', new Map([['en-US', {}]]))
		expect(state.state).toBe('ready')
		if (state.state !== 'ready') return
		expect(state.runtime.translate('en-US', 'user_{id}', { id: '42' })).toEqual({
			text: '⟦missing:user_{id}⟧',
			warnings: [{ code: 'unresolved-key', key: 'user_{id}', requestedLocale: 'en-US' }],
		})
	})

	it('treats exact empty strings as present blank copy and reports empty/whitespace only through static reminders', () => {
		const resources = new Map([['en-US', { blank: '', spaces: ' \t\n', text: 'ok' }]])
		const state = createTranslationRuntime('en-US', resources)
		expect(state.state).toBe('ready')
		if (state.state !== 'ready') return
		expect(state.runtime.translate('en-US', 'blank')).toEqual({ text: '', warnings: [] })
		const findings = inspectTranslationResources('en-US', resources)
		expect(findings.map(item => item.diagnostic.code)).toEqual([
			'i18n.empty_translation',
			'i18n.whitespace_only_translation',
		])
		expect(findings.every(item => item.severity === 'warning' && !item.blocksTranslationExecution)).toBe(true)
	})

	it('implements matching brace depth, repeated parameters, malformed-fragment recovery, and empty argument semantics', () => {
		const result = interpolateTemplate(
			'{name}|{{name}}|{{{name}}}|{{{{name}}}}|{{{{{name}}}}}|{missing}-{missing}|{{bad}{name}|{bad-name}|{empty}',
			{ name: 'Ada', empty: '' },
			'key',
			'en-US',
		)
		expect(result.text).toBe('Ada|{name}|{Ada}|{{name}}|{{Ada}}|⟦missing-param:missing⟧-⟦missing-param:missing⟧|{{bad}Ada|{bad-name}|')
		expect(result.warnings).toEqual([
			{ code: 'missing-parameter', key: 'key', requestedLocale: 'en-US', parameter: 'missing' },
		])
	})

	it('orders distinct missing-parameter warnings by first template occurrence while substituting every occurrence', () => {
		const result = interpolateTemplate('{second}/{first}/{second}/{third}', {}, 'order', 'en-US')
		expect(result.text).toBe('⟦missing-param:second⟧/⟦missing-param:first⟧/⟦missing-param:second⟧/⟦missing-param:third⟧')
		expect(result.warnings.map(warning => warning.code === 'missing-parameter' ? warning.parameter : '')).toEqual(['second', 'first', 'third'])
	})

	it('blocks translation-dependent execution when the primary locale file is missing', () => {
		const state = createTranslationRuntime('en-US', new Map([['zh-TW', { title: '標題' }]]))
		expect(state.state).toBe('blocked')
		expect(state.findings).toContainEqual(expect.objectContaining({
			severity: 'error',
			blocksTranslationExecution: true,
			diagnostic: expect.objectContaining({ code: 'i18n.missing_default_locale' }),
		}))
	})

	it('blocks translation runtime when the discovered primary locale resource itself is schema-invalid', async () => {
		const { root, persistence } = await newWorkspace()
		await mkdir(join(root, 'i18n'), { recursive: true })
		await writeFile(join(root, 'i18n', 'en-US.json'), JSON.stringify({ nested: { invalid: true } }))
		const inspected = await inspectWorkspaceI18n('en-US', persistence.locales)
		expect(inspected.locales).toEqual(['en-US'])
		expect(inspected.resourceDiagnostics.some(item => item.code === 'i18n.non_flat_value')).toBe(true)
		expect(inspected.runtime.state).toBe('blocked')
	})

	it('does not let a secondary locale whose name shares the primary prefix block translation execution', async () => {
		const { root, persistence } = await newWorkspace('en')
		await persistence.locales.create('en', { title: 'Title' })
		await mkdir(join(root, 'i18n'), { recursive: true })
		await writeFile(join(root, 'i18n', 'en-US.json'), JSON.stringify({ nested: { invalid: true } }))
		const inspected = await inspectWorkspaceI18n('en', persistence.locales)
		expect(inspected.resourceDiagnostics.some(item => item.path.startsWith('/i18n/en-US'))).toBe(true)
		expect(inspected.runtime.state).toBe('ready')
	})

	it('lowers $i18n only for Catalog-declared author fields', () => {
		const fields: Record<string, I18nFieldMapping> = {
			title: { configField: 'titleKey', resultProperty: 'localizedTitle', textProperty: 'titleText', params: { count: 'formattedCount' } },
		}
		expect(lowerI18nBinding({ binding: { $i18n: 'checkout.title' }, authorField: 'title', fields })).toEqual({
			state: 'ready',
			diagnostics: [],
			value: {
				authorField: 'title', configField: 'titleKey', key: 'checkout.title', resultProperty: 'localizedTitle', textProperty: 'titleText', params: { count: 'formattedCount' },
			},
		})
		const invalid = lowerI18nBinding({ binding: { $i18n: 'checkout.title' }, authorField: 'subtitle', fields })
		expect(invalid.state).toBe('invalid')
		expect(invalid.diagnostics.some(item => item.code === 'i18n.field_not_eligible')).toBe(true)
	})

	it('rejects conflicting Catalog i18n runtime member mappings before runtime assembly', () => {
		const result = validateAdapterManifest({
			id: 'catalog', apiVersion: 'fixture-api', widgetPlugins: [], renderers: [], providers: [], styles: [], tokens: [],
			catalog: {
				widgets: {
					Label: {
						i18n: {
							fields: {
								title: { configField: 'titleKey', resultProperty: 'localized', textProperty: 'titleText' },
								subtitle: { configField: 'subtitleKey', resultProperty: 'localized', textProperty: 'subtitleText' },
							},
						},
					},
				},
			},
		})
		expect(result.ok).toBe(false)
		expect(result.diagnostics.some(item => item.code === 'adapter.i18n_mapping_collision')).toBe(true)
	})

	it('uses filesystem-discovered canonical locales and keeps invalid filenames out of the supported set', async () => {
		const { root, persistence } = await newWorkspace()
		await persistence.locales.create('en-US', { title: 'Title' })
		await persistence.locales.create('zh-TW', { title: '標題' })
		await writeFile(join(root, 'i18n', 'EN-us.json'), JSON.stringify({ title: 'bad casing' }))

		const inspected = await inspectWorkspaceI18n('en-US', persistence.locales)
		expect(inspected.locales).toEqual(['en-US', 'zh-TW'])
		expect(inspected.resources.get('zh-TW')).toEqual({ title: '標題' })
		expect(inspected.resourceDiagnostics.some(item => item.code === 'i18n.invalid_locale_filename')).toBe(true)
		expect(inspected.runtime.state).toBe('ready')
	})
})

describe('authored Asset application and execution semantics', () => {
	it('replaces metadata and bytes through the shared application service while preserving UUID and detecting stale revisions', async () => {
		const { persistence } = await newWorkspace()
		const original = asset('original.png', 'Original', pngBytes(1))
		await persistence.assets.create(ASSET_ID, original)
		const current = await persistence.assets.read(ASSET_ID)
		const service = createAssetService({ repository: persistence.assets, impact: noImpact })

		const replaced = await service.mutateAsset({
			key: ASSET_ID,
			expectedRevision: current!.revision,
			mutate: resource => ({ ...resource, metadata: { ...resource.metadata, name: 'Replaced', contentFilename: 'replaced.png' }, content: pngBytes(2) }),
			changeSummary: ['metadata', 'content'],
		})
		expect(replaced.status).toBe('updated')
		const after = await persistence.assets.read(ASSET_ID)
		expect(after?.resource.metadata.id).toBe(ASSET_ID)
		expect(after?.resource.metadata.name).toBe('Replaced')
		expect(after?.revision).not.toBe(current?.revision)

		const stale = await service.mutateAsset({
			key: ASSET_ID,
			expectedRevision: current!.revision,
			mutate: resource => ({ ...resource, metadata: { ...resource.metadata, name: 'Stale overwrite' } }),
			changeSummary: ['metadata.name'],
		})
		expect(stale).toEqual({ status: 'conflict', key: ASSET_ID, currentRevision: after!.revision })
	})

	it('keeps the prior Asset pair intact when persistence fails during application-level replacement', async () => {
		const root = await makeRoot()
		let armed = false
		const persistence = new FileNativePersistence({
			root, schemaPolicy: policy(),
			fault(point: PersistenceFaultPoint, details) {
				if (armed && point === 'asset.before_apply' && details.index === 1) { armed = false; throw new Error('injected asset apply failure') }
			},
		})
		await persistence.workspace.create(workspaceFixture())
		const original = asset('original.png', 'Original', pngBytes(1))
		await persistence.assets.create(ASSET_ID, original)
		const current = await persistence.assets.read(ASSET_ID)
		const oldMetadata = await readFile(join(root, 'assets', ASSET_ID, 'asset.json'))
		const oldContent = await readFile(join(root, 'assets', ASSET_ID, 'original.png'))
		const service = createAssetService({ repository: persistence.assets, impact: noImpact })
		armed = true
		await expect(service.mutateAsset({
			key: ASSET_ID, expectedRevision: current!.revision,
			mutate: resource => ({ ...resource, metadata: { ...resource.metadata, contentFilename: 'next.png' }, content: pngBytes(3) }),
			changeSummary: ['content'],
		})).rejects.toThrow(/asset/i)
		expect(await readFile(join(root, 'assets', ASSET_ID, 'asset.json'))).toEqual(oldMetadata)
		expect(await readFile(join(root, 'assets', ASSET_ID, 'original.png'))).toEqual(oldContent)
	})

	it('blocks missing and media-incompatible $asset bindings without rewriting authored references', async () => {
		const binding = { $asset: ASSET_ID } as const
		const missing = await resolveAssetBindingForExecution({
			binding,
			capability: { acceptedMediaTypes: ['image/png'] },
			lookup: { async read() { return undefined } },
		})
		expect(missing.state).toBe('blocked')
		expect(missing.diagnostics.some(item => item.code === 'asset.missing_reference')).toBe(true)
		expect(binding).toEqual({ $asset: ASSET_ID })

		const target = asset('photo.png', 'Photo', pngBytes(1))
		const incompatible = await resolveAssetBindingForExecution({
			binding,
			capability: { acceptedMediaTypes: ['image/jpeg'] },
			lookup: { async read() { return { resource: target, diagnostics: [] } } },
		})
		expect(incompatible.state).toBe('blocked')
		expect(incompatible.diagnostics.some(item => item.code === 'asset.incompatible_media_type')).toBe(true)
		expect(binding).toEqual({ $asset: ASSET_ID })
	})

	it('uses inspected Asset reads so on-disk extra-content corruption blocks formal execution', async () => {
		const { root, persistence } = await newWorkspace()
		await persistence.assets.create(ASSET_ID, asset('photo.png', 'Photo', pngBytes(1)))
		await writeFile(join(root, 'assets', ASSET_ID, 'unexpected.bin'), Buffer.from('extra'))
		const result = await resolveAssetBindingForExecution({
			binding: { $asset: ASSET_ID },
			capability: { acceptedMediaTypes: ['image/png'] },
			lookup: assetLookupFromInspectedSource(persistence.assets),
		})
		expect(result.state).toBe('blocked')
		expect(result.diagnostics.some(item => item.code === 'asset.invalid_content_file_count')).toBe(true)
	})

	it('fails closed if an integration Asset lookup omits its diagnostic array', async () => {
		const result = await resolveAssetBindingForExecution({
			binding: { $asset: ASSET_ID },
			capability: { acceptedMediaTypes: ['image/png'] },
			lookup: { async read() { return { resource: { metadata: null, content: pngBytes(1) } } as never } },
		})
		expect(result.state).toBe('blocked')
		expect(result.diagnostics.some(item => item.code === 'schema.expected_object')).toBe(true)
	})

	it('returns structured blockers instead of throwing when referenced Asset metadata is corrupt', async () => {
		const result = await resolveAssetBindingForExecution({
			binding: { $asset: ASSET_ID },
			capability: { acceptedMediaTypes: ['image/png'] },
			lookup: { async read() { return { resource: { metadata: null, content: pngBytes(1) } as unknown as AuthoredAssetResource, diagnostics: [{ code: 'schema.expected_object', path: '/metadata', message: 'bad metadata' }] } } },
		})
		expect(result.state).toBe('blocked')
		expect(result.diagnostics.some(item => item.code === 'schema.expected_object')).toBe(true)
	})

	it('rejects asset.json as source content filename before persistence can overwrite metadata', async () => {
		const { persistence } = await newWorkspace()
		const invalid = asset('asset.json', 'Collision', pngBytes(1))
		const serviceResult = createAssetService({
			repository: {
				async read() { return { resource: invalid, revision: 'r1' as never } },
				async compareAndSwap() { throw new Error('must not commit') },
			},
			impact: noImpact,
		})
		const mutation = await serviceResult.mutateAsset({
			key: ASSET_ID, expectedRevision: 'r1' as never, mutate: resource => resource, changeSummary: ['noop'],
		})
		expect(mutation.status).toBe('invalid')
		await expect(persistence.assets.create(ASSET_ID, invalid)).rejects.toThrow(/contentFilename|filename|path/i)
	})

	it('blocks corrupt/inconsistent referenced assets and returns a content identity only for valid executable bindings', async () => {
		const valid = asset('photo.png', 'Photo', pngBytes(1))
		const ready = await resolveAssetBindingForExecution({
			binding: { $asset: ASSET_ID },
			capability: { acceptedMediaTypes: ['image/png'] },
			lookup: { async read() { return { resource: valid, diagnostics: [] } } },
		})
		expect(ready.state).toBe('ready')
		if (ready.state === 'ready') {
			expect(ready.value.assetId).toBe(ASSET_ID)
			expect(ready.value.mediaType).toBe('image/png')
			expect(ready.value.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
		}

		const corrupt = await resolveAssetBindingForExecution({
			binding: { $asset: ASSET_ID },
			capability: { acceptedMediaTypes: ['image/png'] },
			lookup: { async read() { return { resource: valid, diagnostics: [{ code: 'asset.content_filename_mismatch', path: '/contentFilename', message: 'bad pair' }] } } },
		})
		expect(corrupt.state).toBe('blocked')
	})
})

const noImpact = { async analyze() { return [] as const } }


function asset(filename: string, name: string, content: Uint8Array): AuthoredAssetResource {
	return { metadata: { id: ASSET_ID, name, contentFilename: filename, mediaType: 'image/png' }, content }
}

function pngBytes(marker: number): Uint8Array {
	return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, marker])
}

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-i18n-assets-'))
	temporaryRoots.push(root)
	return root
}

async function newWorkspace(defaultLocale = 'en-US'): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await makeRoot()
	const persistence = new FileNativePersistence({ root, schemaPolicy: policy() })
	await persistence.workspace.create(workspaceFixture(defaultLocale))
	return { root, persistence }
}

function policy() {
	return defineWorkspaceSchemaPolicy({ currentVersion: 2, recognizedVersions: [2], steps: [] })
}

function workspaceFixture(defaultLocale = 'en-US'): WorkspaceManifest {
	return { schemaVersion: 2, i18n: { defaultLocale }, adapters: [], viewports: {}, themes: {} }
}
