import * as fs from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import packageJson from '../../../package.json' with { type: 'json' }
import { canonicalJsonBytes } from '../../domain/canonical-json'
import { sha256Identity } from '../../domain/artifacts/schema'
import type { AdapterProvenance, AdapterWidgetCatalogEntry } from '../../domain/adapters/schema'
import { validateAssetBinding } from '../../domain/assets/schema'
import {
	validateFormalEvidenceRecord,
	type EvidenceReference,
	type FormalEvidenceRecord,
} from '../../domain/evidence/schema'
import { renderInputDigest } from '../../domain/evidence/render-input-digest'
import { evaluateEvidenceStaleness } from '../../domain/evidence/staleness'
import {
	mayClaimImplementationReady,
	validateHandoffManifest,
	validateHandoffRoot,
	type HandoffArtifactReference,
	type HandoffBlockingDiagnostic,
	type HandoffComponentReference,
	type HandoffManifest,
	type HandoffReadiness,
	type HandoffReadinessAssessment,
	type HandoffResourceSnapshot,
	type HandoffRoot,
	type HandoffSourceReference,
	type HandoffWidgetImplementationReference,
} from '../../domain/handoff/schema'
import type { ResolvedRenderContext } from '../../domain/render-context/schema'
import type { Diagnostic, JsonObject } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'
import { workspaceRefusalMessage } from '../../persistence/schema-policy'
import {
	adapterResolutionBase,
	NodeAdapterManifestLoader,
	NodeWorkspaceAdapterModuleResolver,
	resolveWorkspaceAdapterSet,
	type AdapterSetResolutionResult,
	type ValidatedAdapterSet,
} from '../../adapters/resolution'
import { adapterGraphDigest } from '../../adapters/adapter-graph-digest'
import { bareSpecifierPackageName } from '../../adapters/kit-dependencies'
import { resolveKitPackage } from '../../adapters/kit-packages'
import { locateKitProject, type KitProject } from '../../adapters/kit-registry'
import { readKitSourceFile } from '../../adapters/kit-source-files'
import { componentDigest } from '../../domain/product-kit/digest'
import { PRODUCT_KIT_RESOURCE_KEY, PRODUCT_KIT_RESOURCE_KIND, validateProductKit, type ProductKit } from '../../domain/product-kit/schema'
import { productKitFreshnessContext, type ProductKitProvenance } from '../../domain/product-kit/provenance'
import { readCurrentProductKitProvenance } from './product-kit-provenance'
import {
	extractProductAdapterManifest,
	productAdapterApiCompatibility,
	productAdapterRegistryInspector,
} from '../../adapters/product-integration'
import { collectWidgetTypesFromIr } from '../../preview/preview-runtime'
import { deriveReviewResolution, isWorkspaceAnchor, REVIEW_RESOLUTIONS, type ReviewResolution } from '../../domain/reviews/schema'

/** The package path of UIUX's own RootShell source, whose semantic and renderer source a Handoff names. */
const ROOT_SHELL_SOURCE_PATH = 'src/runtime/root-shell.ts'
/** The public Adapter authoring entry's declarations, which RootShell's source imports its interfaces from. */
const ROOT_SHELL_ENTRY_TYPES_PATH = 'src/adapter-entry/index.d.ts'

export type ExportHandoffCommand = Readonly<{
	roots: readonly HandoffRoot[]
}>

/**
 * Handoff is refused while the Workspace is not at the current schema: this UIUX cannot read the
 * files that export and readiness would be computed against.
 */
export type HandoffSchemaBlocked = Readonly<{
	status: 'blocked'
	key: 'handoff'
	code: 'workspace.schema_unsupported'
	message: string
	diagnostics: readonly Diagnostic[]
}>

export type ExportHandoffResult = HandoffSchemaBlocked | Readonly<{
	status: 'exported' | 'failed'
	manifest?: HandoffManifest
	manifestArtifactDigest?: string
	bundleIdentity?: string
	readiness?: HandoffReadiness
	assessment?: HandoffReadinessAssessment
	diagnostics?: readonly Diagnostic[]
}>

export type AssessHandoffReadinessCommand = Readonly<{
	roots: readonly HandoffRoot[]
}>

export type AssessHandoffReadinessResult = HandoffSchemaBlocked | Readonly<{
	status: 'ok' | 'failed'
	readiness?: HandoffReadiness
	assessment?: HandoffReadinessAssessment
	diagnostics?: readonly Diagnostic[]
}>

/**
 * The server-side check of a resolved Adapter set's runtime members (Clause
 * 01a116f0-cae2-7c64-9c76-d472f252789a), plugin authenticity among them: `invalid` when the evaluated
 * Preview bundle reported a mismatch, `unchecked` when the check could not run (owner decision during
 * review of #248). The server injects it; without it Handoff resolves the manifests only. Diagnostic
 * paths index the given set.
 */
export type AdapterSetRuntimeCheck = (set: ValidatedAdapterSet) => Promise<
	| Readonly<{ state: 'valid' }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ state: 'unchecked'; warnings: readonly Diagnostic[] }>
>

export interface HandoffExportService {
	assessReadiness(command: AssessHandoffReadinessCommand): Promise<AssessHandoffReadinessResult>
	exportHandoff(command: ExportHandoffCommand): Promise<ExportHandoffResult>
}

export function createHandoffExportService(persistence: FileNativePersistence, options: Readonly<{ checkAdapterSet?: AdapterSetRuntimeCheck }> = {}): HandoffExportService {
	async function blockedForSchema(): Promise<HandoffSchemaBlocked | undefined> {
		const { inspection } = await persistence.inspectWorkspace()
		if (inspection.state === 'unsupported')
			return { status: 'blocked', key: 'handoff', code: 'workspace.schema_unsupported', message: workspaceRefusalMessage(inspection, 'Handoff is blocked for an unsupported Workspace schema.'), diagnostics: inspection.diagnostics }
		return undefined
	}

	/**
	 * Content identity of closure bytes. Export stores them in the immutable artifact store; a
	 * readiness assessment only needs the digest and must not write (it is a read-only tool).
	 */
	async function contentIdentity(bytes: Uint8Array, materialize: boolean): Promise<string> {
		return materialize ? (await persistence.artifacts.put(bytes)).identity : await sha256Identity(bytes)
	}

	/**
	 * The `component` of an implementation reference (Clause 01a11bb1-bbed-7588-bce6-5e1f4f0bcf72)
	 * for the component table entry `mapping`. A registry component's files are read as `uiux
	 * components add` reads them (`readKitSourceFile`, kit-relative paths, never through a link),
	 * each stored as a `component-file` artifact by content identity; its digest is the component
	 * digest of Clause 01a11bb1-8b0c-…. An external export names its package and the version found
	 * installed, none when none is. A component the kit cannot supply gives a `problem` instead.
	 */
	async function componentReference(
		mapping: ProductKit['widgets'][string],
		productKit: ProductKit,
		kit: KitProject | undefined,
		materialize: boolean,
		artifacts: Map<string, HandoffArtifactReference>,
	): Promise<Readonly<{ component: HandoffComponentReference } | { problem: string }>> {
		if ('import' in mapping) {
			const packageName = bareSpecifierPackageName(mapping.import) ?? mapping.import
			const installed = kit ? await resolveKitPackage(kit, packageName) : undefined
			const version = installed?.status === 'resolved' ? installed.version : undefined
			return { component: { import: mapping.import, export: mapping.export, package: packageName, ...(version ? { version } : {}) } }
		}
		const name = mapping.component
		const registered = Object.hasOwn(productKit.components, name) ? productKit.components[name] : undefined
		if (!registered) return { problem: `the registry component ${name}, which the registry does not hold.` }
		if (!kit) return { problem: `the registry component ${name}, but the Workspace has no kit project to read it from.` }
		const files: Array<Readonly<{ path: string; digest: string }>> = []
		const digests: Record<string, string> = {}
		for (const path of registered.files) {
			const read = await readKitSourceFile(kit, path, { maxBytes: Number.POSITIVE_INFINITY })
			if (read.status !== 'found') return { problem: `the registry component ${name}, whose file kit/${path} is not a regular file under kit/src/ reached without a symbolic link.` }
			const digest = await contentIdentity(read.bytes, materialize)
			digests[path] = digest
			files.push({ path, digest })
		}
		// Referenced only once every file was read: a component the manifest does not name adds no file.
		for (const { path, digest } of files) artifacts.set(digest, { kind: 'component-file', artifact: digest, context: { component: name, path } })
		return { component: { name, componentDigest: await componentDigest(digests), files, add: `uiux components add ${name}` } }
	}

	async function computeClosure(roots: readonly HandoffRoot[], materialize: boolean): Promise<
		| {
				ok: true
				assessment: HandoffReadinessAssessment
				resources: readonly HandoffResourceSnapshot[]
				artifactRefs: readonly HandoffArtifactReference[]
				evidenceRefs: readonly EvidenceReference[]
				implementationReferences: readonly HandoffWidgetImplementationReference[]
				adaptersInClosure: readonly AdapterProvenance[]
				contextsInClosure: readonly ResolvedRenderContext[]
				wsSchemaVersion: number
				/** The Product Kit provenance at export, when it is available. */
				productKitProvenance?: ProductKitProvenance
				/** `coverage.review`: completeness plus per-resolution counts over the closure. */
				reviewCoverage: Readonly<{ complete: boolean; threads: number; workspaceThreads: number; resolved: Readonly<Record<ReviewResolution, number>> }>
		  }
		| {
				ok: false
				diagnostics: readonly Diagnostic[]
		  }
	> {
		if (!Array.isArray(roots) || roots.length === 0) {
			return {
				ok: false,
				diagnostics: [{
					code: 'handoff.empty_roots',
					path: '/roots',
					message: 'Handoff roots are required and must not be empty.',
				}],
			}
		}

		// Validate roots individually
		const rootDiagnostics: Diagnostic[] = []
		const seenRootKeys = new Set<string>()
		for (let i = 0; i < roots.length; i++) {
			const root = roots[i]!
			const res = validateHandoffRoot(root, `/roots/${i}`)
			if (!res.ok) {
				rootDiagnostics.push(...res.diagnostics)
			}
			const key = rootIdentityKey(root)
			if (key && seenRootKeys.has(key)) {
				rootDiagnostics.push({
					code: 'handoff.duplicate_root',
					path: `/roots/${i}`,
					message: 'Handoff roots are explicit identities and must not be duplicated.',
				})
			}
			if (key) seenRootKeys.add(key)
		}
		if (rootDiagnostics.length > 0) {
			return { ok: false, diagnostics: rootDiagnostics }
		}

		const blockingDiagnostics: HandoffBlockingDiagnostic[] = []
		let rootsReadable = true
		let closureValid = true

		const wsRead = await persistence.workspace.readInspected()
		if (!wsRead.resource || !wsRead.revision) {
			blockingDiagnostics.push({
				code: 'workspace.manifest_missing',
				message: 'Workspace manifest is missing or unreadable.',
				blocking: true,
			})
			return {
				ok: false,
				diagnostics: blockingDiagnostics.map(d => ({ code: d.code, path: d.path ?? '', message: d.message })),
			}
		}
		const wsSchemaVersion = wsRead.resource.schemaVersion ?? 1
		// The Adapter list is the Product Kit file's, and a `./` Adapter resolves from `kit/` (Clauses
		// 01a1144e-538e-705f-afdc-841028c410e4 and 01a115cd-d109-76d3-9622-85d0080c60b6).
		const workspaceAdapters = (await persistence.productKit.read())?.resource.adapters ?? []
		const adapterModuleResolver = () => new NodeWorkspaceAdapterModuleResolver({ layout: persistence.layout })

		const viewsToInclude = new Set<string>()
		const flowsToInclude = new Set<string>()
		const assetsToInclude = new Set<string>()
		const localesToInclude = new Set<string>([wsRead.resource.i18n?.defaultLocale ?? 'en-US'])
		let includeAll = false

		for (const root of roots) {
			switch (root.type) {
				case 'workspace':
					includeAll = true
					break
				case 'view':
					viewsToInclude.add(root.viewId)
					break
				case 'flow':
					flowsToInclude.add(root.flowId)
					break
				case 'asset':
					assetsToInclude.add(root.assetId)
					break
			}
		}

		if (includeAll) {
			const allViews = await persistence.views.discoverKeys()
			const allFlows = await persistence.flows.discoverKeys()
			const allAssets = await persistence.assets.discoverKeys()
			const allLocales = await persistence.locales.discover()
			allViews.forEach(id => viewsToInclude.add(id))
			allFlows.forEach(id => flowsToInclude.add(id))
			allAssets.forEach(id => assetsToInclude.add(id))
			allLocales.forEach(loc => localesToInclude.add(loc))
		}

		// 1. Process Flows -> transitively add target Views
		const flowSnapshots = new Map<string, HandoffResourceSnapshot>()
		for (const flowId of flowsToInclude) {
			const flowRead = await persistence.flows.readInspected(flowId)
			if (!flowRead?.resource) {
				rootsReadable = false
				blockingDiagnostics.push({
					code: 'handoff.missing_root_flow',
					message: `Flow root ${flowId} could not be read.`,
					blocking: true,
					path: `/flows/${flowId}`,
				})
				continue
			}
			if (flowRead.diagnostics.length > 0) {
				closureValid = false
				flowRead.diagnostics.forEach(d => {
					blockingDiagnostics.push({
						code: d.code,
						message: d.message,
						path: `/flows/${flowId}${d.path || ''}`,
						blocking: true,
					})
				})
			}
			flowSnapshots.set(flowId, {
				type: 'flow',
				identity: { id: flowId },
				revision: flowRead.revision,
				snapshot: flowRead.resource as unknown as JsonObject,
			})
			for (const step of Object.values(flowRead.resource.steps || {})) {
				if (step?.target?.viewId) {
					viewsToInclude.add(step.target.viewId)
				}
			}
		}

		// 2. Process Views -> transitively add referenced Assets
		const viewSnapshots = new Map<string, HandoffResourceSnapshot>()
		const usedWidgetTypes = new Set<string>()
		const viewIrSources: unknown[] = []

		for (const viewId of viewsToInclude) {
			const viewRead = await persistence.views.readInspected(viewId)
			if (!viewRead?.resource) {
				rootsReadable = false
				blockingDiagnostics.push({
					code: 'handoff.missing_view',
					message: `View ${viewId} could not be read.`,
					blocking: true,
					path: `/views/${viewId}`,
				})
				continue
			}
			if (viewRead.diagnostics.length > 0) {
				closureValid = false
				viewRead.diagnostics.forEach(d => {
					blockingDiagnostics.push({
						code: d.code,
						message: d.message,
						path: `/views/${viewId}${d.path || ''}`,
						blocking: true,
					})
				})
			}
			viewSnapshots.set(viewId, {
				type: 'view',
				identity: { id: viewId },
				revision: viewRead.revision,
				snapshot: viewRead.resource as unknown as JsonObject,
			})
			viewIrSources.push(viewRead.resource.ir)

			// Collect widget types
			const types = collectWidgetTypesFromIr(viewRead.resource.ir)
			types.forEach(t => usedWidgetTypes.add(t))

			// Check spec references for assets
			const references = viewRead.resource.spec?.references ?? []
			for (const ref of references) {
				if (typeof ref === 'object' && ref !== null) {
					const r = ref as Record<string, unknown>
					if (r.type === 'asset' && typeof r.id === 'string') {
						assetsToInclude.add(r.id)
					}
					else if (typeof r.uri === 'string' && r.uri.startsWith('uiux://asset/')) {
						const assetId = r.uri.slice('uiux://asset/'.length).split(/[?#]/)[0]
						if (assetId) assetsToInclude.add(assetId)
					}
				}
			}
		}

		// Adapter Catalog assetFields declare which authored Config fields may contain
		// canonical {$asset} bindings. Discover those references from View IR before
		// materializing the Asset closure; do not guess from arbitrary strings.
		const assetCatalogByWidgetType = new Map<string, AdapterWidgetCatalogEntry[]>()
		const rawAdaptersForAssetDiscovery = workspaceAdapters
		const nonRootWidgetTypes = new Set([...usedWidgetTypes].filter(type => type !== 'RootShell'))
		if (nonRootWidgetTypes.size > 0 && rawAdaptersForAssetDiscovery.length > 0) {
			for (const selection of rawAdaptersForAssetDiscovery) {
				try {
					const single = await resolveWorkspaceAdapterSet({
						workspaceRoot: persistence.root,
						adapters: [selection],
						resolver: adapterModuleResolver(),
						loader: new NodeAdapterManifestLoader(extractProductAdapterManifest),
						apiCompatibility: productAdapterApiCompatibility,
						registryInspector: productAdapterRegistryInspector,
					})
					if (single.state !== 'valid' || !single.set.entries[0]) continue
					const entry = single.set.entries[0]
					for (const widgetType of entry.ownership.widgetTypes) {
						if (!nonRootWidgetTypes.has(widgetType)) continue
						const catalog = entry.manifest.catalog.widgets[widgetType]
						if (!catalog?.assetFields) continue
						const catalogs = assetCatalogByWidgetType.get(widgetType) ?? []
						catalogs.push(catalog)
						assetCatalogByWidgetType.set(widgetType, catalogs)
					}
				}
				catch {
					// Adapter validity/ownership is enforced later by the implementation-source gate.
				}
			}
		}

		for (const ir of viewIrSources) {
			const discovered = collectAssetReferencesFromIr(ir, assetCatalogByWidgetType)
			discovered.assetIds.forEach(assetId => assetsToInclude.add(assetId))
			if (discovered.diagnostics.length > 0) {
				closureValid = false
				blockingDiagnostics.push(...discovered.diagnostics.map(diagnostic => ({
					code: diagnostic.code,
					message: diagnostic.message,
					path: diagnostic.path,
					blocking: true,
				})))
			}
		}
		// 3. Process Assets -> ensure content is in artifact store
		const assetSnapshots = new Map<string, HandoffResourceSnapshot>()
		const referencedArtifacts = new Map<string, HandoffArtifactReference>()

		for (const assetId of assetsToInclude) {
			const assetRead = await persistence.assets.readInspected(assetId)
			if (!assetRead?.resource) {
				rootsReadable = false
				blockingDiagnostics.push({
					code: 'handoff.missing_asset',
					message: `Asset ${assetId} could not be read.`,
					blocking: true,
					path: `/assets/${assetId}`,
				})
				continue
			}
			if (assetRead.diagnostics.length > 0) {
				closureValid = false
				assetRead.diagnostics.forEach(d => {
					blockingDiagnostics.push({
						code: d.code,
						message: d.message,
						path: `/assets/${assetId}${d.path || ''}`,
						blocking: true,
					})
				})
			}

			const contentIdentityValue = await contentIdentity(assetRead.resource.content, materialize)
			referencedArtifacts.set(contentIdentityValue, {
				kind: 'asset-content',
				artifact: contentIdentityValue,
				context: { assetId },
			})

			assetSnapshots.set(assetId, {
				type: 'asset',
				identity: { id: assetId },
				revision: assetRead.revision,
				snapshot: assetRead.resource.metadata as JsonObject,
				contentDigest: contentIdentityValue,
			})
		}

		// 4. Process Locales in closure
		const localeSnapshots = new Map<string, HandoffResourceSnapshot>()
		for (const locale of localesToInclude) {
			const locRead = await persistence.locales.readInspected(locale)
			if (locRead?.resource) {
				if (locRead.diagnostics.length > 0) {
					closureValid = false
					locRead.diagnostics.forEach(d => {
						blockingDiagnostics.push({
							code: d.code,
							message: d.message,
							path: `/i18n/${locale}.json${d.path || ''}`,
							blocking: true,
						})
					})
				}
				localeSnapshots.set(locale, {
					type: 'locale',
					identity: { id: locale },
					revision: locRead.revision,
					snapshot: locRead.resource as JsonObject,
				})
			}
		}

		// 5. Workspace Snapshot
		const workspaceSnapshot: HandoffResourceSnapshot = {
			type: 'workspace',
			identity: { id: 'workspace' },
			revision: wsRead.revision,
			snapshot: wsRead.resource as JsonObject,
		}

		// 5b. Rule 01a11bb1-bd7c-7117-8c54-ceb9881db19c: the Product Kit file travels with every bundle,
		// so implementers get its style entries and theme attributes; Clause 01a115cd-d7ba-…: its
		// provenance at export.
		const productKitRead = await persistence.productKit.readInspected().catch(() => undefined)
		const productKitSnapshot: HandoffResourceSnapshot | undefined = productKitRead
			? { type: PRODUCT_KIT_RESOURCE_KIND, identity: { id: PRODUCT_KIT_RESOURCE_KEY }, revision: productKitRead.revision, snapshot: productKitRead.resource as unknown as JsonObject }
			: undefined
		const productKitValidation = productKitRead ? validateProductKit(productKitRead.resource) : undefined
		const productKit = productKitValidation?.ok ? productKitValidation.value : undefined
		const currentProductKit = await readCurrentProductKitProvenance(persistence)
		const productKitProvenance = currentProductKit.state === 'available' ? currentProductKit.provenance : undefined

		// 6. Review Threads in the closure: those anchored to a View in the closure, and every
		// Workspace-scoped thread (owner decision O1: the Workspace manifest is in every bundle, so a
		// thread about the Workspace is in the closure of every export and never silently skipped).
		const reviewSnapshots = new Map<string, HandoffResourceSnapshot>()
		const allReviewIds = await persistence.reviews.discoverKeys()
		let reviewCoverageComplete = true
		let reviewThreadCount = 0
		let workspaceThreadCount = 0
		// Machine-readable breakdown over the closure: only `verified` means a change was evidence-checked;
		// every other kind is closed without a verified change and never counts as verified.
		const resolvedReviewCounts = Object.fromEntries(REVIEW_RESOLUTIONS.map(kind => [kind, 0])) as Record<ReviewResolution, number>

		for (const revId of allReviewIds) {
			const revRead = await persistence.reviews.readInspected(revId)
			if (!revRead?.resource) continue
			const anchor = revRead.resource.anchor
			const workspaceScoped = isWorkspaceAnchor(anchor)
			const targetViewId = !workspaceScoped && typeof anchor?.viewId === 'string' ? anchor.viewId : undefined
			if (!workspaceScoped && (!targetViewId || !viewsToInclude.has(targetViewId))) continue
			const subject = workspaceScoped ? `Workspace-scoped Review thread ${revId}` : `Review thread ${revId} anchored to View ${targetViewId}`

			reviewSnapshots.set(revId, {
				type: 'review',
				identity: { id: revId },
				revision: revRead.revision,
				snapshot: revRead.resource as unknown as JsonObject,
			})

			reviewThreadCount += 1
			if (workspaceScoped) workspaceThreadCount += 1
			// Review readiness: open threads block implementationReady; every resolution kind is closed.
			if (revRead.resource.status === 'open' || revRead.resource.status === 'ready-for-review') {
				reviewCoverageComplete = false
				blockingDiagnostics.push({
					code: 'handoff.unresolved_review_thread',
					message: `${subject} is ${revRead.resource.status}.`,
					blocking: true,
					path: `/reviews/${revId}`,
				})
			}
			else {
				const resolution = deriveReviewResolution(revRead.resource)
				if (resolution) resolvedReviewCounts[resolution] += 1
				if (resolution === 'wont-fix') {
					// Advisory only: a declined request is what downstream implementers most need to see.
					blockingDiagnostics.push({
						code: 'handoff.review_declined',
						message: `${subject} was resolved as won't fix: the requested change was declined.`,
						blocking: false,
						path: `/reviews/${revId}`,
					})
				}
			}
		}

		// Evidence freshness uses the same current-context semantics as Workbench.
		// Discover locale revisions independently of closure roots so a non-default
		// capture locale can be validated before it is admitted into the closure.
		const currentLocaleRevisions: Record<string, string> = {}
		for (const locale of await persistence.locales.discover()) {
			const localeRead = await persistence.locales.readInspected(locale)
			if (localeRead?.resource) currentLocaleRevisions[locale] = localeRead.revision
		}
		// 7. Evidence Records in closure
		const evidenceRefs: EvidenceReference[] = []
		const contextsInClosure: ResolvedRenderContext[] = []
		const artifactIdentities = await persistence.artifacts.listIdentities()
		// Rule 01a115cd-c5a5-…: each closure View's current render-input digest, taken once.
		const stalenessViews = [...viewSnapshots.entries()].map(([key, snapshot]) => ({ key, renderInputDigest: renderInputDigest(snapshot.snapshot) }))
		const viewEvidenceMap = new Map<string, FormalEvidenceRecord[]>()
		const staleEvidenceByView = new Map<string, number>()

		for (const identity of artifactIdentities) {
			const parsed = await persistence.artifacts.readCandidateJson(identity)
			if (!parsed) continue
			const validation = validateFormalEvidenceRecord(parsed)
			if (!validation.ok || validation.value.kind !== 'formal_capture') continue
			const formalRec = validation.value
			const execCtx = formalRec.executionContext as Record<string, unknown> | undefined
			const evViewId = execCtx?.viewId as string | undefined
			if (evViewId && viewsToInclude.has(evViewId)) {
				const staleness = evaluateEvidenceStaleness(formalRec, {
					allViews: stalenessViews,
					workspace: wsRead,
					discoveredLocales: Object.keys(currentLocaleRevisions),
					localeRevisions: currentLocaleRevisions,
					...productKitFreshnessContext(currentProductKit),
				})

				if (!staleness.isStale) {
					evidenceRefs.push({
						kind: formalRec.kind,
						evidence: identity,
					})
					referencedArtifacts.set(identity, {
						kind: 'formal-evidence-record',
						artifact: identity,
						context: { viewId: evViewId },
					})
					for (const ref of formalRec.artifactRefs) {
						referencedArtifacts.set(ref, {
							kind: 'screenshot',
							artifact: ref,
							context: { viewId: evViewId },
						})
					}
					const list = viewEvidenceMap.get(evViewId) ?? []
					list.push(formalRec)
					viewEvidenceMap.set(evViewId, list)
					const evidenceLocale = typeof execCtx?.locale === 'string' ? execCtx.locale : undefined
					if (evidenceLocale && !localeSnapshots.has(evidenceLocale)) {
						const localeRead = await persistence.locales.readInspected(evidenceLocale)
						if (localeRead?.resource) {
							localeSnapshots.set(evidenceLocale, {
								type: 'locale',
								identity: { id: evidenceLocale },
								revision: localeRead.revision,
								snapshot: localeRead.resource as JsonObject,
							})
						}
					}

					if (execCtx) {
						contextsInClosure.push({
							viewId: evViewId,
							...(typeof execCtx.variantName === 'string' && execCtx.variantName.length > 0 ? { variantName: execCtx.variantName } : {}),
							locale: (execCtx.locale as string) || 'en-US',
							viewportId: (execCtx.viewportId as string) || 'default',
							viewport: (execCtx.viewport as { width: number; height: number }) || { width: 1280, height: 800 },
							themeId: (execCtx.themeId as string) || 'light',
						})
					}
				}
				else {
					staleEvidenceByView.set(evViewId, (staleEvidenceByView.get(evViewId) ?? 0) + 1)
				}
			}
		}

		// Check required evidence completeness
		let requiredEvidenceComplete = true
		for (const viewId of viewsToInclude) {
			const evs = viewEvidenceMap.get(viewId)
			if (!evs || evs.length === 0) {
				requiredEvidenceComplete = false
				const staleCount = staleEvidenceByView.get(viewId) ?? 0
				if (staleCount > 0) {
					blockingDiagnostics.push({
						code: 'handoff.stale_view_evidence',
						message: `View ${viewId} only has stale evidence from prior revisions. Fresh formal capture is required.`,
						blocking: true,
						path: `/views/${viewId}`,
					})
				}
				else {
					blockingDiagnostics.push({
						code: 'handoff.missing_view_evidence',
						message: `View ${viewId} has no captured formal evidence.`,
						blocking: true,
						path: `/views/${viewId}`,
					})
				}
			}
			else {
				for (const ev of evs) {
					if (!ev.coverage?.complete) {
						requiredEvidenceComplete = false
						blockingDiagnostics.push({
							code: 'handoff.incomplete_view_evidence',
							message: `Evidence for View ${viewId} indicates incomplete coverage.`,
							blocking: true,
							path: `/views/${viewId}`,
						})
					}
				}
			}
		}

		// 8. Adapters & Widget Implementation References
		const neededWidgetTypes = new Set([...usedWidgetTypes].filter(t => t !== 'RootShell'))
		const rawAdapters = workspaceAdapters
		const neededAdapterSelections: typeof rawAdapters = []
		/** The Product Kit index of each needed selection, to name it in a diagnostic. */
		const neededAdapterIndexes: number[] = []

		if (neededWidgetTypes.size > 0 && rawAdapters.length > 0) {
			for (let i = 0; i < rawAdapters.length; i++) {
				const selection = rawAdapters[i]!
				try {
					const singleRes = await resolveWorkspaceAdapterSet({
						workspaceRoot: persistence.root,
						adapters: [selection],
						resolver: adapterModuleResolver(),
						loader: new NodeAdapterManifestLoader(extractProductAdapterManifest),
						apiCompatibility: productAdapterApiCompatibility,
						registryInspector: productAdapterRegistryInspector,
					})
					if (singleRes.state === 'valid' && singleRes.set.entries[0]) {
						const entry = singleRes.set.entries[0]
						const providesNeeded = entry.ownership.widgetTypes.some(t => neededWidgetTypes.has(t))
						if (providesNeeded) {
							neededAdapterSelections.push(selection)
							neededAdapterIndexes.push(i)
						}
					}
				}
				catch {
					// Ignore individual candidate errors here; resolving neededAdapterSelections will enforce contracts
				}
			}
		}

		let adaptersResolution: AdapterSetResolutionResult = {
			state: 'valid',
			diagnostics: [],
			summaries: [],
			set: Object.freeze({ entries: Object.freeze([]), [Symbol.for('ValidatedAdapterSet')]: true }) as never,
		}

		if (neededAdapterSelections.length > 0) {
			adaptersResolution = await resolveWorkspaceAdapterSet({
				workspaceRoot: persistence.root,
				adapters: neededAdapterSelections,
				resolver: adapterModuleResolver(),
				loader: new NodeAdapterManifestLoader(extractProductAdapterManifest),
				apiCompatibility: productAdapterApiCompatibility,
				registryInspector: productAdapterRegistryInspector,
			})
		}

		// The server-side runtime check of the Adapters (Clause 01a116f0-cae2-7c64-9c76-d472f252789a):
		// an Adapter set the Preview refuses, such as one whose plugins come from another widget-core
		// copy, contributes no source and blocks, as on every other surface. A check that could not run
		// is a non-blocking note.
		if (adaptersResolution.state === 'valid' && options.checkAdapterSet) {
			const check = await options.checkAdapterSet(adaptersResolution.set)
			const atWorkspaceIndex = (path: string) => path.replace(/^\/adapters\/(\d+)(?=\/|$)/u, (_, index: string) => `/adapters/${neededAdapterIndexes[Number(index)] ?? index}`)
			if (check.state === 'invalid') {
				closureValid = false
				blockingDiagnostics.push(...check.diagnostics.map(diagnostic => ({ code: diagnostic.code, message: diagnostic.message, path: atWorkspaceIndex(diagnostic.path), blocking: true })))
				adaptersResolution = { state: 'invalid', diagnostics: check.diagnostics, summaries: adaptersResolution.summaries }
			}
			else if (check.state === 'unchecked') {
				blockingDiagnostics.push(...check.warnings.map(diagnostic => ({ code: diagnostic.code, message: diagnostic.message, path: diagnostic.path, blocking: false })))
			}
		}

		const adapterProvenances: AdapterProvenance[] = []
		const implementationReferences: HandoffWidgetImplementationReference[] = []

		if (adaptersResolution.state === 'valid') {
			for (const entry of adaptersResolution.set.entries) {
				try {
					const modBytes = await fs.readFile(entry.resolvedModule.resolvedPath)
					const moduleIdentity = await contentIdentity(modBytes, materialize)
					referencedArtifacts.set(moduleIdentity, {
						kind: 'adapter-module',
						artifact: moduleIdentity,
						context: { adapterId: entry.manifest.id },
					})
				}
				catch {
					// could not read local file
				}
				// Clause 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5: the content digest covers the Adapter's whole
				// bundled module graph (its imports, stylesheets and assets), not only its entry module.
				const contentDigest = await adapterGraphDigest({
					workspaceRoot: persistence.root,
					moduleBase: adapterResolutionBase(persistence.root, persistence.layout),
					entry: entry.resolvedModule.resolvedPath,
				})

				adapterProvenances.push({
					moduleSpecifier: entry.selection.moduleSpecifier,
					adapterId: entry.manifest.id,
					apiVersion: entry.manifest.apiVersion,
					moduleIdentity: entry.resolvedModule.moduleIdentity,
					...(entry.resolvedModule.packageVersion ? { packageVersion: entry.resolvedModule.packageVersion } : {}),
					...(contentDigest ? { contentDigest } : {}),
				})
			}
		}

		for (const widgetType of usedWidgetTypes) {
			if (widgetType === 'RootShell') {
				// RootShell's source and the public Adapter authoring entry's declarations, which define the
				// `RootShellInterfaces` its source imports by relative path (Discussion #241 owner decision 3
				// during review of #251), are read from one package root.
				let rsBytes: Uint8Array | undefined
				let entryTypesBytes: Uint8Array | undefined
				const candidateRoots = [
					resolve(process.env.UIUX_PACKAGE_ROOT ?? ''),
					process.cwd(),
					resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
				]
				for (const packageRoot of candidateRoots) {
					try {
						rsBytes = await fs.readFile(resolve(packageRoot, ROOT_SHELL_SOURCE_PATH))
					}
					catch {
						continue
					}
					entryTypesBytes = await fs.readFile(resolve(packageRoot, ROOT_SHELL_ENTRY_TYPES_PATH)).catch(() => undefined)
					break
				}
				const rootShellProvenance = (path: string) => ({ package: '@deviltea/uiux', path, revision: packageJson.version })

				if (rsBytes && rsBytes.length > 0) {
					const putRs = { identity: await contentIdentity(rsBytes, materialize) }
					referencedArtifacts.set(putRs.identity, {
						kind: 'widget-source',
						artifact: putRs.identity,
						context: { widgetType: 'RootShell' },
					})
					let entryTypesSource: HandoffSourceReference = { availability: 'provenance-only', provenance: rootShellProvenance(ROOT_SHELL_ENTRY_TYPES_PATH) }
					if (entryTypesBytes && entryTypesBytes.length > 0) {
						const entryTypesIdentity = await contentIdentity(entryTypesBytes, materialize)
						referencedArtifacts.set(entryTypesIdentity, {
							kind: 'widget-source',
							artifact: entryTypesIdentity,
							context: { widgetType: 'RootShell' },
						})
						entryTypesSource = { availability: 'materialized', provenance: rootShellProvenance(ROOT_SHELL_ENTRY_TYPES_PATH), contentDigest: entryTypesIdentity }
					}
					implementationReferences.push({
						widgetType: 'RootShell',
						semanticSource: {
							availability: 'materialized',
							provenance: rootShellProvenance(ROOT_SHELL_SOURCE_PATH),
							contentDigest: putRs.identity,
						},
						rendererSource: {
							availability: 'materialized',
							provenance: rootShellProvenance(ROOT_SHELL_SOURCE_PATH),
							contentDigest: putRs.identity,
						},
						supportingSources: [entryTypesSource],
					})
				}
				else {
					implementationReferences.push({
						widgetType: 'RootShell',
						semanticSource: {
							availability: 'provenance-only',
							provenance: rootShellProvenance(ROOT_SHELL_SOURCE_PATH),
						},
						rendererSource: {
							availability: 'provenance-only',
							provenance: rootShellProvenance(ROOT_SHELL_SOURCE_PATH),
						},
						supportingSources: [{ availability: 'provenance-only', provenance: rootShellProvenance(ROOT_SHELL_ENTRY_TYPES_PATH) }],
					})
				}
				continue
			}

			// Find matching adapter
			const matchingEntry = adaptersResolution.state === 'valid'
				? adaptersResolution.set.entries.find(e => e.ownership.widgetTypes.includes(widgetType))
				: undefined

			if (matchingEntry) {
				let contentDigest: string | undefined
				let availability: 'materialized' | 'provenance-only' = 'provenance-only'
				try {
					const modBytes = await fs.readFile(matchingEntry.resolvedModule.resolvedPath)
					contentDigest = await contentIdentity(modBytes, materialize)
					availability = 'materialized'
					referencedArtifacts.set(contentDigest, {
						kind: 'widget-source',
						artifact: contentDigest,
						context: { widgetType },
					})
				}
				catch {
					// Fall back to provenance-only
				}

				if (availability === 'materialized' && contentDigest) {
					const sourceRef = {
						availability: 'materialized' as const,
						provenance: {
							package: matchingEntry.resolvedModule.packageName || '@workspace',
							path: matchingEntry.selection.moduleSpecifier,
							revision: matchingEntry.resolvedModule.packageVersion || contentDigest,
						},
						contentDigest,
					}
					implementationReferences.push({
						widgetType,
						semanticSource: sourceRef,
						rendererSource: sourceRef,
					})
				}
				else {
					const sourceRef = {
						availability: 'provenance-only' as const,
						provenance: {
							package: matchingEntry.resolvedModule.packageName || '@workspace',
							path: matchingEntry.selection.moduleSpecifier,
						},
					}
					implementationReferences.push({
						widgetType,
						semanticSource: sourceRef,
						rendererSource: sourceRef,
					})
				}
			}
			else {
				closureValid = false
				blockingDiagnostics.push({
					code: 'handoff.unavailable_widget_source',
					message: `Widget type ${widgetType} has no registered adapter implementation.`,
					blocking: true,
				})
				implementationReferences.push({
					widgetType,
					semanticSource: {
						availability: 'unavailable',
						provenance: { widgetType },
					},
					rendererSource: {
						availability: 'unavailable',
						provenance: { widgetType },
					},
				})
			}
		}

		// 9. Rule 01a11bb1-bde1-7146-abc4-31a3e7f4e371: the implementation reference of a used Widget
		// type that the component table maps names its registry component, each file materialized by
		// content identity, or its external export (Clause 01a11bb1-bbed-7588-bce6-5e1f4f0bcf72).
		if (productKit && Object.keys(productKit.widgets).length > 0) {
			const kitProject = persistence.layout.codeDir ? await locateKitProject(persistence.root, persistence.layout.codeDir).catch(() => undefined) : undefined
			for (const [index, reference] of implementationReferences.entries()) {
				const mapping = Object.hasOwn(productKit.widgets, reference.widgetType) ? productKit.widgets[reference.widgetType] : undefined
				if (!mapping) continue
				const component = await componentReference(mapping, productKit, kitProject, materialize, referencedArtifacts)
				if ('problem' in component) {
					blockingDiagnostics.push({
						code: 'handoff.component_unavailable',
						message: `Widget type ${reference.widgetType} maps to ${component.problem}`,
						blocking: false,
						path: `/product-kit/widgets/${escapeJsonPointer(reference.widgetType)}`,
					})
					continue
				}
				implementationReferences[index] = { ...reference, component: component.component }
			}
		}

		// Assemble all resources
		const resources: HandoffResourceSnapshot[] = [
			workspaceSnapshot,
			...(productKitSnapshot ? [productKitSnapshot] : []),
			...viewSnapshots.values(),
			...flowSnapshots.values(),
			...assetSnapshots.values(),
			...localeSnapshots.values(),
			...reviewSnapshots.values(),
		]

		// Deterministic resource sorting: by type, then by id
		resources.sort((a, b) => {
			const typeCmp = a.type.localeCompare(b.type)
			if (typeCmp !== 0) return typeCmp
			const aId = String(a.identity.id ?? '')
			const bId = String(b.identity.id ?? '')
			return aId.localeCompare(bId)
		})

		// Deduplicate and sort artifactRefs
		const artifactRefs = [...referencedArtifacts.values()].sort((a, b) => a.artifact.localeCompare(b.artifact))

		// Sort evidenceRefs
		evidenceRefs.sort((a, b) => a.evidence.localeCompare(b.evidence))

		// Sort implementationReferences by widgetType
		implementationReferences.sort((a, b) => a.widgetType.localeCompare(b.widgetType))

		// Sort adapterProvenances by adapterId
		adapterProvenances.sort((a, b) => a.adapterId.localeCompare(b.adapterId))

		// Sort contextsInClosure
		contextsInClosure.sort((a, b) => {
			const vCmp = a.viewId.localeCompare(b.viewId)
			if (vCmp !== 0) return vCmp
			return a.locale.localeCompare(b.locale)
		})

		blockingDiagnostics.sort((left, right) => {
			const leftKey = `${left.code}\u0000${left.path ?? ''}\u0000${left.message}\u0000${left.blocking ? '1' : '0'}`
			const rightKey = `${right.code}\u0000${right.path ?? ''}\u0000${right.message}\u0000${right.blocking ? '1' : '0'}`
			return leftKey.localeCompare(rightKey)
		})
		const assessment: HandoffReadinessAssessment = {
			rootsReadable,
			closureValid,
			requiredEvidenceComplete,
			reviewCoverageComplete,
			blockingDiagnostics,
		}
		const reviewCoverage = {
			complete: reviewCoverageComplete,
			threads: reviewThreadCount,
			// Handoff manifest content delta (accepted O1): how many closure threads are Workspace-scoped.
			workspaceThreads: workspaceThreadCount,
			resolved: resolvedReviewCounts,
		}

		return {
			ok: true,
			assessment,
			reviewCoverage,
			resources,
			artifactRefs,
			evidenceRefs,
			implementationReferences,
			adaptersInClosure: adapterProvenances,
			contextsInClosure,
			wsSchemaVersion,
			...(productKitProvenance ? { productKitProvenance } : {}),
		}
	}

	async function assessReadiness(command: AssessHandoffReadinessCommand): Promise<AssessHandoffReadinessResult> {
		const blocked = await blockedForSchema()
		if (blocked) return blocked
		const closureRes = await computeClosure(command.roots, false)
		if (!closureRes.ok) {
			return {
				status: 'failed',
				diagnostics: closureRes.diagnostics,
			}
		}

		const { assessment, reviewCoverage } = closureRes
		const implementationReady = mayClaimImplementationReady(assessment)
		const readiness: HandoffReadiness = {
			implementationReady,
			coverage: {
				validation: { complete: assessment.closureValid },
				evidence: { complete: assessment.requiredEvidenceComplete },
				review: reviewCoverage,
			},
			blockingDiagnostics: assessment.blockingDiagnostics,
		}

		return {
			status: 'ok',
			readiness,
			assessment,
			diagnostics: assessment.blockingDiagnostics.map(d => ({ code: d.code, path: d.path ?? '', message: d.message })),
		}
	}

	async function exportHandoff(command: ExportHandoffCommand): Promise<ExportHandoffResult> {
		const blocked = await blockedForSchema()
		if (blocked) return blocked
		const closureRes = await computeClosure(command.roots, true)
		if (!closureRes.ok) {
			return {
				status: 'failed',
				diagnostics: closureRes.diagnostics,
			}
		}

		const {
			assessment,
			resources,
			artifactRefs,
			evidenceRefs,
			implementationReferences,
			adaptersInClosure,
			contextsInClosure,
			wsSchemaVersion,
			productKitProvenance,
			reviewCoverage,
		} = closureRes

		const implementationReady = mayClaimImplementationReady(assessment)
		const readiness: HandoffReadiness = {
			implementationReady,
			coverage: {
				validation: { complete: assessment.closureValid },
				evidence: { complete: assessment.requiredEvidenceComplete },
				review: reviewCoverage,
			},
			blockingDiagnostics: assessment.blockingDiagnostics,
		}

		// Sort roots deterministically for payload
		const sortedRoots = [...command.roots].sort((a, b) => {
			const keyA = rootIdentityKey(a) || ''
			const keyB = rootIdentityKey(b) || ''
			return keyA.localeCompare(keyB)
		})

		const provenance = {
			workspaceSchemaVersion: wsSchemaVersion,
			scope: sortedRoots,
			resources: resources.map(r => ({ identity: r.identity, revision: r.revision })),
			contexts: contextsInClosure,
			versions: {
				uiux: packageJson.version,
			},
			adapters: adaptersInClosure,
			...(productKitProvenance ? { productKit: productKitProvenance } : {}),
		}

		// Deterministic bundle payload: defines bundleIdentity over deterministic content
		// excluding volatile exportedAt and bundleIdentity
		const deterministicBundlePayload = {
			schemaVersion: 1,
			roots: sortedRoots,
			resources,
			artifactRefs,
			evidenceRefs,
			implementationReferences,
			provenance,
			readiness,
		}

		const payloadBytes = canonicalJsonBytes(deterministicBundlePayload)
		const bundleIdentity = await sha256Identity(payloadBytes)

		const manifest: HandoffManifest = {
			schemaVersion: 1,
			bundleIdentity,
			exportedAt: new Date().toISOString(),
			roots: sortedRoots,
			resources,
			artifactRefs,
			evidenceRefs,
			implementationReferences,
			provenance,
			readiness,
		}

		const manifestValidation = validateHandoffManifest(manifest)
		if (!manifestValidation.ok) {
			return {
				status: 'failed',
				diagnostics: manifestValidation.diagnostics,
			}
		}

		// Canonically serialize manifest and store in ImmutableArtifactStore
		const manifestBytes = canonicalJsonBytes(manifest)
		const { identity: manifestArtifactDigest } = await persistence.artifacts.put(manifestBytes)

		return {
			status: 'exported',
			manifest,
			manifestArtifactDigest,
			bundleIdentity,
			readiness,
			assessment,
			diagnostics: assessment.blockingDiagnostics.map(d => ({ code: d.code, path: d.path ?? '', message: d.message })),
		}
	}

	return {
		assessReadiness,
		exportHandoff,
	}
}

function collectAssetReferencesFromIr(
	ir: unknown,
	catalogByWidgetType: ReadonlyMap<string, readonly AdapterWidgetCatalogEntry[]>,
): Readonly<{ assetIds: ReadonlySet<string>; diagnostics: readonly Diagnostic[] }> {
	const assetIds = new Set<string>()
	const diagnostics: Diagnostic[] = []

	function scan(node: unknown, path: string): void {
		if (!isObjectRecord(node)) return
		const widgetType = typeof node.type === 'string' ? node.type : undefined
		const config = isObjectRecord(node.config) ? node.config : undefined
		if (widgetType && config) {
			const assetFields = new Set<string>()
			for (const catalog of catalogByWidgetType.get(widgetType) ?? []) {
				for (const field of Object.keys(catalog.assetFields ?? {})) assetFields.add(field)
			}
			for (const field of assetFields) {
				if (!Object.hasOwn(config, field)) continue
				const authored = config[field]
				if (!isObjectRecord(authored) || !Object.hasOwn(authored, '$asset')) continue
				const fieldPath = `${path}/config/${escapeJsonPointer(field)}`
				const binding = validateAssetBinding(authored, fieldPath)
				if (!binding.ok) diagnostics.push(...binding.diagnostics)
				else assetIds.add(binding.value.$asset)
			}
		}

		if (!isObjectRecord(node.slots)) return
		for (const [slotName, children] of Object.entries(node.slots)) {
			if (!Array.isArray(children)) continue
			children.forEach((child, index) => scan(child, `${path}/slots/${escapeJsonPointer(slotName)}/${index}`))
		}
	}

	scan(ir, '/ir')
	return { assetIds, diagnostics }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeJsonPointer(value: string): string {
	return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
function rootIdentityKey(input: HandoffRoot): string | undefined {
	switch (input.type) {
		case 'workspace': return 'workspace'
		case 'view': return `view:${input.viewId}`
		case 'flow': return `flow:${input.flowId}`
		case 'asset': return `asset:${input.assetId}`
		default: return undefined
	}
}
