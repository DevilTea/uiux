import { randomUUID } from 'node:crypto'

import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError, ResourceTemplate, createMcpHandler, type AuthInfo, type McpHttpHandler, type ReadResourceResult } from '@modelcontextprotocol/server'
import packageJson from '../../package.json' with { type: 'json' }
import { z } from 'zod'

import { DISCOVERABLE_RESOURCE_KINDS, MAX_RESOURCE_DISCOVERY_LIMIT, REVIEW_ANCHOR_SCOPES, REVIEW_DISCOVERY_STATUSES } from '../application/dto/resource-discovery'
import { REVIEW_ANCHOR_STATES } from '../domain/reviews/anchor-state'
import type { PointResourceKind } from '../application/dto/point-resources'
import type { WorkspaceApplicationSession } from '../application/services/workspace-session'
import { LOCKABLE_KINDS, MAX_ACQUIRE_RESOURCES, type LeaseManager } from '../application/access/leases'
import { memberLabelName } from '../application/access/labels'
import type { Principal } from '../application/access/principal'
import { effectiveKeys } from '../application/access/policy'
import { createScopedWorkspaceSession, type ScopedSessionOptions, type ScopedWorkspaceSession } from '../application/access/scoped-session'
import type { ViewSpecContent } from '../application/services/view-authoring'
import { VERSION_DIFF_DETAILS } from '../application/services/history-diff'
import { DEFAULT_VERSION_LIST_LIMIT, MAX_VERSION_LIST_LIMIT } from '../application/services/history-service'
import { HISTORY_VERSION_TYPES } from '../domain/history/constants'
import type { ViewResource } from '../domain/views/schema'
import type { FlowStep } from '../domain/flows/schema'
import { REVIEW_RESOLUTIONS, type ReviewAnchor, type ReviewDisplayHint, type ReviewEvidenceRef, type ReviewRenderContext, type ReviewResourceRevision } from '../domain/reviews/schema'
import { CHANGE_DOMAINS } from '../domain/reviews/change-domains'
import type { ThemeEntry, ViewportPreset } from '../domain/workspace/schema'
import type { ProductKitComponent, ProductKitWidgetMapping } from '../domain/product-kit/schema'
import { ACCESS_PRESETS_RESOURCE_KIND } from '../domain/access-presets/schema'
import { isFullUuid, isSha256Digest, type JsonObject, type JsonValue } from '../domain/validation'
import type { ResolvedRenderContext } from '../domain/render-context/schema'
import type { HandoffRoot } from '../domain/handoff/schema'
import { isPersistenceBusyError, persistenceBusyResult } from '../persistence/busy'
import { KIT_FILE_RESOURCE_TEMPLATE, kitFileResourceUri, parsePointResourceUri, pointResourceUri } from './resource-uri'
import { kitFileContent } from '../application/services/kit-source'

const dynamicKinds = ['view', 'flow', 'locale', 'review', 'asset'] as const satisfies readonly PointResourceKind[]
const discoveryKindsSchema = z.array(z.enum(DISCOVERABLE_RESOURCE_KINDS)).optional()
const discoveryBaseShape = {
	kinds: discoveryKindsSchema,
	resolution: z.array(z.enum(REVIEW_RESOLUTIONS)).min(1).optional()
		.describe('Review threads only: resolved threads whose current resolution is listed.'),
	anchorScope: z.array(z.enum(REVIEW_ANCHOR_SCOPES)).min(1).optional()
		.describe('Review threads only: "workspace" selects Workspace-scoped threads, "view" every thread anchored to a View or Widget.'),
	status: z.array(z.enum(REVIEW_DISCOVERY_STATUSES)).min(1).optional()
		.describe('Review threads only: "resolved" is resolved as verified or answered, "dismissed" resolved as wont-fix, duplicate or obsolete.'),
	viewId: z.array(z.string().min(1)).min(1).optional()
		.describe('Review threads only: View IDs, or "workspace" for Workspace-scoped threads.'),
	variant: z.array(z.string().min(1)).min(1).optional()
		.describe('Review threads only: Variant names in the thread\'s Variant scope, or "*" for View-wide threads; never matches a Workspace thread.'),
	anchor: z.array(z.enum(REVIEW_ANCHOR_STATES)).min(1).optional()
		.describe('Review threads only: "missing" when the anchored View or Widget no longer exists, "stale" when only a named Variant no longer exists, "valid" otherwise.'),
	changeDomain: z.array(z.enum(CHANGE_DOMAINS)).min(1).optional()
		.describe('Review threads only: threads with any submission naming a listed change domain.'),
	cursor: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(MAX_RESOURCE_DISCOVERY_LIMIT),
}
const listResourcesSchema = z.object(discoveryBaseShape).strict()
const searchResourcesSchema = z.object({ ...discoveryBaseShape, query: z.string().min(1) }).strict()

const viewSpecContentSchema = z.object({
	intent: z.string(),
	entryConditions: z.array(z.string()),
	interactionRules: z.array(z.string()),
	constraints: z.array(z.string()),
	accessibility: z.array(z.string()),
	references: z.array(z.unknown()),
}).strict()

const createViewSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	feature: z.string().optional(),
	spec: viewSpecContentSchema,
}).strict()

const updateViewSpecSchema = z.object({
	viewId: z.string(),
	expectedRevision: z.string(),
	spec: viewSpecContentSchema,
}).strict()

const updateViewStructureSchema = z.object({
	viewId: z.string(),
	expectedRevision: z.string(),
	ir: z.record(z.string(), z.unknown()),
	variants: z.record(z.string(), z.unknown()),
}).strict()

// Clause 01a15379-d8f7-7c0c-9b9a-05c07c64cc85: the service refuses a call that gives neither name nor feature as invalid.
const updateViewMetadataSchema = z.object({
	viewId: z.string(),
	expectedRevision: z.string(),
	name: z.string().optional().describe('The new display name, stored trimmed; non-empty after trimming, and need not be unique among Views.'),
	feature: z.string().nullable().optional().describe('The new feature tag (a non-empty string), or null to remove the tag.'),
}).strict()

const updateWorkspaceSettingsSchema = z.object({
	expectedRevision: z.string(),
	settings: z.object({
		i18n: z.object({
			defaultLocale: z.string(),
		}).catchall(z.unknown()),
		viewports: z.record(z.string(), z.object({
			dimensions: z.object({
				width: z.number(),
				height: z.number(),
			}).catchall(z.unknown()),
		}).catchall(z.unknown())),
		themes: z.record(z.string(), z.record(z.string(), z.unknown())),
	}).strict(),
}).strict()

// Clause 01a11bb1-b15c-734e-8968-c378db1444ca: the Product Kit operations; the domain validator reports member shapes.
const composeProductKitSchema = z.object({
	expectedRevision: z.string().describe('The Product Kit revision, read from uiux://product-kit.'),
	designSystems: z.array(z.string()).describe('External Design System package names, each a dependency kit/package.json declares.'),
	adapters: z.array(z.string()).describe('The Adapter module specifiers in order: a bare specifier of a package kit/package.json declares, or a ./ specifier relative to kit/. A kept Adapter keeps its config; an added one has none.'),
}).strict()

const updateProductKitSchema = z.object({
	expectedRevision: z.string().describe('The Product Kit revision, read from uiux://product-kit.'),
	adapters: z.array(z.object({
		moduleSpecifier: z.string(),
		config: z.unknown().optional(),
	}).strict()).describe('The current Adapters, with the same specifiers in the same order, each with the config to store (none when omitted).'),
	styles: z.array(z.string()).describe('Stylesheet specifiers: a bare specifier into a declared package, or a ./ path inside kit/.'),
	themes: z.record(z.string(), z.record(z.string(), z.unknown())).describe('Root attributes per theme ID, such as { "dark": { "data-theme": "dark" } }.'),
}).strict()

const updateComponentRegistrySchema = z.object({
	expectedRevision: z.string().describe('The Product Kit revision, read from uiux://product-kit.'),
	components: z.record(z.string(), z.unknown()).describe('The component registry: name → { files, requires?, packages?, layer: "design-system" | "product" }, files relative to kit/ under kit/src/.'),
	widgets: z.record(z.string(), z.unknown()).describe('The component table: Widget type → { component } naming a registry component, or { import, export } naming an external package export.'),
}).strict()

// Clauses 01a11bb1-b227-77a8-ab57-c287ca5d2bfd and 01a11bb1-b28f-7be6-9d53-3782729297a7: the kit source Tools.
const getComponentSourceSchema = z.object({
	name: z.string().describe('A component name of the Product Kit registry (resource.components of uiux://product-kit).'),
	withRequires: z.boolean().optional().describe('true also returns every component it requires, transitively, as uiux components add copies them; false by default.'),
}).strict()

const recordedCopySchema = z.object({
	target: z.string().optional(),
	componentDigest: z.string().optional(),
	exportedAt: z.string().optional(),
	files: z.record(z.string(), z.object({ source: z.string(), digest: z.string() }).strict()),
}).strict()

const compareComponentCopiesSchema = z.object({
	copies: z.record(z.string(), recordedCopySchema).describe('The components member of the product project\'s copy record (uiux-components.json): component name → { target, componentDigest, exportedAt, files }, files mapping each copied file\'s path to { source, digest }. Only files is read.'),
}).strict()

/** The URI of the Product Kit Resource (Clause 01a11bb1-b0f1-7e5d-85ad-230c43ad99fb). */
export const PRODUCT_KIT_RESOURCE_URI = 'uiux://product-kit'

const createLocaleSchema = z.object({
	locale: z.string(),
	messages: z.record(z.string(), z.string()),
}).strict()

const updateLocaleSchema = z.object({
	locale: z.string(),
	expectedRevision: z.string(),
	messages: z.record(z.string(), z.string()),
}).strict()

const flowStepSchema = z.object({
	target: z.object({
		viewId: z.string(),
		variantName: z.string().optional(),
	}).strict(),
	transitions: z.array(z.object({
		trigger: z.object({
			widgetId: z.string(),
			event: z.string(),
		}).strict(),
		targetStepId: z.string(),
	}).strict()),
}).strict()

const createFlowSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	scenarioRef: z.record(z.string(), z.unknown()).optional(),
	entryStepId: z.string(),
	steps: z.record(z.string(), flowStepSchema),
}).strict()

const updateFlowSchema = z.object({
	flowId: z.string(),
	expectedRevision: z.string(),
	name: z.string(),
	scenarioRef: z.record(z.string(), z.unknown()).optional(),
	entryStepId: z.string(),
	steps: z.record(z.string(), flowStepSchema),
}).strict()

// The closed anchor union: the Widget arm { viewId, widgetId } or the Workspace arm { scope: "workspace" }.
// Both arms stay strict, so a display hint inside `anchor` is still rejected.
const reviewAnchorSchema = z.union([
	z.object({ viewId: z.string(), widgetId: z.string() }).strict(),
	z.object({ scope: z.literal('workspace') }).strict(),
])

const ANCHOR_DESCRIPTION = 'Use { scope: "workspace" } for feedback about the product as a whole (variantNames must be omitted or [], no displayHint); use { viewId, widgetId: "root" } for a whole View, or { viewId, widgetId } for one Widget.'

const ACTOR_IGNORED_DESCRIPTION = 'Optional and ignored: the server stamps the actor from the authenticated member (a differing value yields the warning auth.actor_ignored).'

const reviewActorSchema = z.object({
	type: z.string(),
	id: z.string().optional(),
	displayName: z.string().optional(),
}).strict()

// Non-authoritative pin placement, beside (never inside) the strict anchor. Services clamp to 0..1
// and quantize to 1e-4 before persisting.
const reviewDisplayHintSchema = z.object({
	pin: z.object({ x: z.number(), y: z.number() }).strict(),
}).strict()

// The render context a Widget thread was raised in: Workspace-local keys, checked against the
// Workspace at write time. Shape and key existence are the service's diagnostics, not the transport's.
const reviewRenderContextSchema = z.object({
	locale: z.string().optional(),
	viewportId: z.string().optional(),
	themeId: z.string().optional(),
}).strict()

const RENDER_CONTEXT_DESCRIPTION = 'Optional render context the feedback was raised in, Widget anchors only: at least one of locale, viewportId, themeId. Each must exist in the Workspace now: a viewport or theme id authored in the Workspace settings (built-in fallbacks such as "default" or "light" are not keys unless authored) and a Locale with an i18n file or the default Locale. An unknown key is refused (review.render_context_unknown_key); a Workspace anchor refuses any renderContext (review.render_context_without_widget).'

const reviewResolutionSchema = z.enum(REVIEW_RESOLUTIONS)

const createReviewThreadSchema = z.object({
	id: z.string().optional(),
	anchor: reviewAnchorSchema.describe(ANCHOR_DESCRIPTION),
	variantNames: z.array(z.string()).optional(),
	displayHint: reviewDisplayHintSchema.optional(),
	renderContext: reviewRenderContextSchema.optional().describe(RENDER_CONTEXT_DESCRIPTION),
}).strict()

const appendReviewMessageSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	body: z.string(),
	id: z.string().optional(),
	at: z.string().optional(),
}).strict()

const reanchorReviewThreadSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	anchor: reviewAnchorSchema.describe(ANCHOR_DESCRIPTION),
	variantNames: z.array(z.string()).optional(),
	displayHint: reviewDisplayHintSchema.nullable().optional(),
	renderContext: reviewRenderContextSchema.nullable().optional().describe(`${RENDER_CONTEXT_DESCRIPTION} An object sets it, null clears it, and omitting it keeps the recorded one.`),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	reason: z.string().optional(),
	id: z.string().optional(),
	at: z.string().optional(),
}).strict()

const setReviewDisplayHintSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	displayHint: reviewDisplayHintSchema.nullable(),
}).strict()

const submitReadyForReviewSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	// A plain string list, so an unknown value is refused by the domain with its own code.
	changeDomains: z.array(z.string()).describe(`What changed, one or more of ${CHANGE_DOMAINS.join(', ')}; any other value is refused with review.change_domain_unknown. spec and metadata (a View's name, feature and other fields outside its Spec and render input) affect no Evidence; flow only Flow Evidence; ir and variant the formal captures of the submission's Views; asset those of the Views binding a changed Asset; i18n those in a changed Locale; settings those in a changed viewport or theme; adapter and product-kit every formal capture.`),
	resources: z.array(z.object({
		identity: z.record(z.string(), z.unknown()),
		revision: z.string(),
	}).strict()),
	scope: z.record(z.string(), z.unknown()).optional(),
	evidenceRefs: z.array(z.object({
		kind: z.string(),
		evidence: z.string(),
	}).strict()),
	reason: z.string().optional(),
	id: z.string().optional(),
	at: z.string().optional(),
	submissionId: z.string().optional(),
}).strict()

const resolveReviewThreadSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	resolution: reviewResolutionSchema.optional(),
	submissionId: z.string().optional(),
	reason: z.string().optional(),
	id: z.string().optional(),
	at: z.string().optional(),
}).strict()

const reopenReviewThreadSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	reason: z.string().optional(),
	id: z.string().optional(),
	at: z.string().optional(),
}).strict()

const editReviewMessageSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	messageId: z.string(),
	body: z.string(),
	editId: z.string().optional(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	at: z.string().optional().describe('Optional and ignored: the server stamps the time (warning auth.time_ignored).'),
}).strict()

const retractReviewThreadSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
}).strict()

const promoteReviewToDecisionSchema = z.object({
	reviewId: z.string(),
	expectedReviewRevision: z.string(),
	viewId: z.string(),
	expectedViewRevision: z.string(),
	question: z.string(),
	outcome: z.object({
		summary: z.string(),
		rationale: z.string(),
	}).strict().optional(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	decisionId: z.string().optional(),
}).strict()

const createAssetSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	contentFilename: z.string(),
	mediaType: z.string(),
	contentBase64: z.string(),
}).strict()

const replaceAssetSchema = z.object({
	assetId: z.string(),
	expectedRevision: z.string(),
	name: z.string(),
	contentFilename: z.string(),
	mediaType: z.string(),
	contentBase64: z.string(),
}).strict()

const captureFormalEvidenceSchema = z.object({
	contexts: z.array(z.object({
		viewId: z.string(),
		variantName: z.string().optional(),
		locale: z.string(),
		viewportId: z.string(),
		viewport: z.object({ width: z.number(), height: z.number() }),
		themeId: z.string(),
	})).min(1),
}).strict()

const handoffRootSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('workspace') }).strict(),
	z.object({ type: z.literal('view'), viewId: z.string() }).strict(),
	z.object({ type: z.literal('flow'), flowId: z.string() }).strict(),
	z.object({ type: z.literal('asset'), assetId: z.string() }).strict(),
])

const assessHandoffReadinessSchema = z.object({
	roots: z.array(handoffRootSchema).min(1),
}).strict()

const exportHandoffSchema = z.object({
	roots: z.array(handoffRootSchema).min(1),
}).strict()

// Clause 01a11a5e-2710-70b7-b63b-82f27236b1cd.
const getVersionDiffSchema = z.object({
	from: z.string().describe('The ID of the version to compare from.'),
	to: z.string().optional().describe('A version ID, or "current" for the Workspace\'s current files (the default).'),
	resources: z.array(z.object({
		kind: z.string().min(1),
		key: z.string().min(1),
	}).strict()).optional().describe('Compare only these resources, each { kind, key } such as { kind: "view", key: <View ID> } or { kind: "workspace", key: "workspace" }; omit to compare every resource.'),
	detail: z.enum(VERSION_DIFF_DETAILS).optional().describe('"summary" (the default) for per-resource statuses only, or "semantic" to add the semantic changes.'),
}).strict()

// Clause 01a11a5e-265d-7f71-80a3-5dae7f788ae1.
const createCheckpointSchema = z.object({
	name: z.string().describe('A descriptive name, 1 to 120 characters after trimming (stored trimmed). Names need not be unique.'),
	note: z.string().optional().describe('Optional plain-text note of at most 2,000 characters.'),
}).strict()

// Clause 01a11a5e-26b9-7dfd-b619-a7e4113809f5.
const listVersionsSchema = z.object({
	resource: z.object({
		kind: z.string().min(1),
		key: z.string().min(1),
	}).strict().optional().describe('List only the versions in which this resource changed, such as { kind: "view", key: <View ID> } or { kind: "workspace", key: "workspace" }.'),
	types: z.array(z.enum(HISTORY_VERSION_TYPES)).min(1).optional().describe('List only these version types.'),
	limit: z.number().int().min(1).max(MAX_VERSION_LIST_LIMIT).optional().describe(`Page size, 1 to ${MAX_VERSION_LIST_LIMIT} (default ${DEFAULT_VERSION_LIST_LIMIT}).`),
	cursor: z.string().min(1).optional().describe('The nextCursor of the previous page.'),
}).strict()

// Clause 01a11a5e-2768-76ad-b02a-e15f50f91268.
const restoreResourceVersionSchema = z.object({
	versionId: z.string().describe('The ID of the version to restore the resource from.'),
	resource: z.object({
		kind: z.string().min(1),
		key: z.string().min(1),
	}).strict().describe('The one resource to restore: { kind: "view" | "flow" | "locale" | "asset", key } or { kind: "workspace", key: "workspace" } for the Workspace settings, or { kind: "product-kit", key: "product-kit" } for the Product Kit.'),
	expectedRevision: z.string().min(1).nullable().describe('The resource\'s current revision, as read now (not the version\'s). Use null to re-create a resource that no longer exists; null requires that it not exist.'),
	acknowledgeImpact: z.boolean().optional().describe('Set true to write after reviewing the impacts an earlier call returned with impact_acknowledgement_required.'),
}).strict()

/** The URI of the read-only version Resource (Clause 01a11a5e-27c1-77d1-b60d-45a5ccfc1ee7 leaves its grammar to the implementation). */
export function versionResourceUri(id: string): string {
	return `uiux://version/${encodeURIComponent(id)}`
}

const leaseResourcesSchema = z.array(z.object({
	kind: z.enum(LOCKABLE_KINDS),
	key: z.string().min(1),
}).strict()).min(1).max(MAX_ACQUIRE_RESOURCES)

const acquireLockSchema = z.object({ resources: leaseResourcesSchema }).strict()
const releaseLockSchema = z.object({ resources: leaseResourcesSchema.optional() }).strict()

export const LEASE_RECIPE = 'Edit leases: your first successful write to a View, Flow, Locale, Asset, the Workspace settings or the Product Kit takes a 5-minute lease on it, renewed by each of your writes; other writers get status "locked" (resource.locked) with your nickname and expiry. For a multi-step task, call acquire_lock up front for every resource you will write, call acquire_lock again as a heartbeat before a long pause (a build, a capture), and finish with release_lock and no arguments. Leases never replace expectedRevision: a conflict still means re-read. Review threads are never locked.'

/**
 * Per-request server instructions (Clause 01a11485-f6ea-7918-bd58-0cdca6d0c432): the Agent learns
 * its identity, label and effective permission keys without a new tool (Discussion #140, decision
 * 12). The keys are the ones that take effect on this credential (`effectiveKeys`), so a bearer
 * Token never lists a `humanOnly` key.
 */
export function uiuxMcpInstructions(principal: Principal): string {
	const keys = effectiveKeys(principal)
	const identity = principal.type === 'member'
		? `Authenticated as ${principal.nickname} (${principal.kind}, ${memberLabelName(principal.label)}). Your effective permission keys: ${keys.length > 0 ? keys.join(', ') : 'none'}.`
		: `Authenticated as ${principal.id}.`
	return `${identity} Actors and times on Review records are stamped by the server from this identity; do not send actor or at. Tools your permission keys do not allow refuse with auth.scope_denied naming the missing keys (requiredKeys). Resolving Review threads is human-only, in the UIUX Workbench. You may edit your own Review messages (until a later submission or resolution) and retract your own brand-new threads nobody has engaged with. ${LEASE_RECIPE} ${CHECKPOINT_RECOMMENDATION}`
}

/**
 * Clause 01a11a5e-2821-7d36-baea-66507ff1f399, verbatim. Advice only (Rule
 * 01a11a5e-1ca3-740d-8235-01106d8ffc25): no Tool requires a Checkpoint before `release_lock`.
 */
export const CHECKPOINT_RECOMMENDATION = 'When you finish a meaningful task that changed design resources, call `create_checkpoint` with a descriptive name, then `release_lock`.'

export function createUiuxMcpServer(app: ScopedWorkspaceSession): McpServer {
	const server = mapPersistenceBusy(new McpServer({ name: '@deviltea/uiux', version: packageJson.version }, { instructions: uiuxMcpInstructions(app.principal) }))
	server.registerResource(
		'workspace',
		pointResourceUri({ kind: 'workspace', key: 'workspace' }),
		{ title: 'Selected UIUX Workspace', mimeType: 'application/json' },
		async uri => resourceResult(app, uri),
	)
	for (const kind of dynamicKinds) {
		server.registerResource(
			kind,
			new ResourceTemplate(`uiux://${kind}/{key}`, { list: undefined }),
			{ title: `UIUX ${kind} point resource`, mimeType: 'application/json' },
			async uri => resourceResult(app, uri),
		)
	}

	// Clause 01a11bb1-b0f1-7e5d-85ad-230c43ad99fb: the Product Kit file with its build state (the kit
	// build runner's under uiux dev), Adapter resolution, resolved external packages and findings. A
	// Workspace without the file has no such Resource.
	server.registerResource(
		'product-kit',
		PRODUCT_KIT_RESOURCE_URI,
		{ title: 'UIUX Product Kit', mimeType: 'application/json' },
		async (uri) => {
			const read = await app.readProductKit()
			if (!read) throw new ResourceNotFoundError(uri.href, `UIUX Product Kit not found: this Workspace has no readable Product Kit file.`)
			return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(read) }] }
		},
	)

	// Clause 01a11bb1-b0f1-7e5d-85ad-230c43ad99fb: one kit project file by its path relative to kit/,
	// percent-encoded as one segment (each / as %2F). Clause 01a11485-fa00-…: `product-kit.source.read`,
	// not `workspace.read`. A path that is not a kit path (absolute, `..`, inside kit/node_modules/) is
	// invalid; a file that is missing, a link or below one is not found (Clause 01a11485-f70a-…). A file above 8 MiB is refused with kit.file_too_large
	// (Clause 01a13d3e-c4b5-…). Nothing names a host path.
	server.registerResource(
		'product-kit-file',
		new ResourceTemplate(KIT_FILE_RESOURCE_TEMPLATE, { list: undefined }),
		{ title: 'UIUX kit project file (read-only)', description: 'One file of the kit project by its path relative to kit/, with each / as %2F. Needs product-kit.source.read. UTF-8 text, else a base64 blob; a file above 8 MiB is refused with kit.file_too_large. list_kit_files lists the files.' },
		async (uri, { path }) => {
			let decoded: string
			try { decoded = decodeURIComponent(typeof path === 'string' ? path : String(path)) }
			catch { throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Invalid kit file path: it is not percent-encoded UTF-8.') }
			const read = await app.readKitFile(decoded)
			if (read.status === 'invalid_path') throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid kit file path: ${read.message}`)
			if (read.status === 'too_large') throw new ProtocolError(ProtocolErrorCode.InvalidParams, `${read.code}: ${read.message}`, { code: read.code, path: read.path, limit: read.limit })
			if (read.status === 'not_found') throw new ResourceNotFoundError(uri.href, `UIUX kit file not found: kit/${read.path} is not a regular file reached without a symbolic link.`)
			if (read.status === 'blocked') throw new ProtocolError(ProtocolErrorCode.InternalError, `${read.code}: ${read.message}`, read)
			const content = kitFileContent(read.bytes)
			return { contents: [content.encoding === 'base64'
				? { uri: uri.href, mimeType: 'application/octet-stream', blob: content.content }
				: { uri: uri.href, mimeType: 'text/plain', text: content.content }] }
		},
	)

	server.registerResource(
		'artifact',
		new ResourceTemplate('uiux://artifact/{digest}', { list: undefined }),
		{ title: 'UIUX immutable content-addressed artifact', mimeType: 'application/octet-stream' },
		async (uri, { digest }) => {
			const digestStr = typeof digest === 'string' ? digest : String(digest)
			if (!isSha256Digest(digestStr)) {
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid artifact digest: ${digestStr}`)
			}
			const bytes = await app.readArtifact(digestStr)
			if (!bytes) {
				throw new ResourceNotFoundError(uri.href, `Artifact not found: ${digestStr}`)
			}
			const isPng = bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50
			if (isPng) {
				return {
					contents: [{ uri: uri.href, mimeType: 'image/png', blob: Buffer.from(bytes).toString('base64') }],
				}
			}
			try {
				const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
				JSON.parse(text)
				return {
					contents: [{ uri: uri.href, mimeType: 'application/json', text }],
				}
			}
			catch {
				return {
					contents: [{ uri: uri.href, mimeType: 'application/octet-stream', blob: Buffer.from(bytes).toString('base64') }],
				}
			}
		},
	)

	// Clause 01a11a5e-27c1-77d1-b60d-45a5ccfc1ee7: each version is a read-only Resource holding its
	// record (its file map and, for an autosave, external or system version, its events). `parent` is
	// its predecessor on the merged timeline, as in list_versions.
	server.registerResource(
		'version',
		new ResourceTemplate('uiux://version/{id}', { list: undefined }),
		{ title: 'UIUX Workspace version (read-only)', mimeType: 'application/json' },
		async (uri, { id }) => {
			const idStr = typeof id === 'string' ? decodeURIComponent(id) : String(id)
			if (!isFullUuid(idStr)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid version ID: ${idStr}`)
			const outcome = await app.readVersion(idStr)
			if (outcome.status === 'not_found') throw new ResourceNotFoundError(uri.href, `UIUX version not found: ${idStr}`)
			if (outcome.status !== 'found') throw new ProtocolError(ProtocolErrorCode.InternalError, `${outcome.code}: ${outcome.message}`, outcome)
			return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(outcome) }] }
		},
	)

	server.registerTool(
		'list_resources',
		{
			title: 'List UIUX resources',
			description: 'List compact canonical resource summaries with stable point-resource URIs. Review filters (resolution, anchorScope, status, viewId, variant, anchor, changeDomain) each match any listed value, combine with AND, and return Review threads only. A Review summary carries latestMessage (id, actor, at, a 200-grapheme excerpt, edited) and, while ready for review or resolved, currentSubmission (id, at, changeDomains).',
			inputSchema: listResourcesSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => discoveryToolResult(app, 'list', input),
	)

	server.registerTool(
		'search_resources',
		{
			title: 'Search UIUX resources',
			description: 'Search compact canonical resource summaries without returning full resource bodies. Takes the same kind and Review filters as list_resources.',
			inputSchema: searchResourcesSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => discoveryToolResult(app, 'search', input),
	)

	server.registerTool(
		'create_view',
		{
			title: 'Create UIUX View',
			description: 'Create a spec-first View with canonical empty RootShell IR, no Variants, and no Decisions. This is a domain-specific authoring operation, not a generic Resource write.',
			inputSchema: createViewSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('view', await app.createView({
			id: input.id ?? randomUUID(),
			name: input.name,
			...(input.feature === undefined ? {} : { feature: input.feature }),
			spec: input.spec as ViewSpecContent,
		})),
	)

	server.registerTool(
		'update_view_spec',
		{
			title: 'Update UIUX View Spec',
			description: 'Replace the descriptive View Spec fields while preserving Decisions and every non-Spec View field. Requires the revision previously read by the caller.',
			inputSchema: updateViewSpecSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('view', await app.updateViewSpec({
			key: input.viewId,
			expectedRevision: input.expectedRevision,
			spec: input.spec as ViewSpecContent,
		})),
	)

	server.registerTool(
		'update_view_structure',
		{
			title: 'Update UIUX View Structure',
			description: 'Replace the canonical View IR and Variants together while preserving View identity, name, feature, and View Spec. Requires the revision previously read by the caller. A Variant varies presentation only through author-writable State: each variants entry is exactly { state }, where state maps Widget IDs to State member overrides; any other entry key (config, id, name) is refused.',
			inputSchema: updateViewStructureSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('view', await app.updateViewStructure({
			key: input.viewId,
			expectedRevision: input.expectedRevision,
			ir: input.ir as ViewResource['ir'],
			variants: input.variants as ViewResource['variants'],
		})),
	)

	server.registerTool(
		'update_view_metadata',
		{
			title: 'Update UIUX View Metadata',
			description: 'Rename a View or set or clear its feature tag: changes only name and feature, at least one of them, and keeps the View identity, IR, Variants, Spec and Decisions, so formal Evidence stays fresh. An omitted field keeps its value; feature null removes the tag. Needs views.write and the revision previously read by the caller; subject to the View\'s edit lease. Refusals: conflict (re-read the View), locked, not_found, invalid_expected_revision, invalid.',
			inputSchema: updateViewMetadataSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('view', await app.updateViewMetadata({
			key: input.viewId,
			expectedRevision: input.expectedRevision,
			...(input.name === undefined ? {} : { name: input.name }),
			...(input.feature === undefined ? {} : { feature: input.feature }),
		})),
	)

	server.registerTool(
		'update_workspace_settings',
		{
			title: 'Update UIUX Workspace Settings',
			description: 'Update manifest-owned Workspace settings (i18n.defaultLocale, viewports, themes) with revision CAS while preserving schemaVersion. The Adapters are the Product Kit\'s (compose_product_kit, update_product_kit).',
			inputSchema: updateWorkspaceSettingsSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('workspace', await app.updateWorkspaceSettings({
			expectedRevision: input.expectedRevision,
			settings: {
				i18n: input.settings.i18n,
				viewports: input.settings.viewports as Record<string, ViewportPreset>,
				themes: input.settings.themes as Record<string, ThemeEntry>,
			},
		})),
	)

	const productKitRefusals = 'Refusals: conflict (re-read uiux://product-kit), locked, invalid (the file\'s own validation, product_kit.specifier_refused, product_kit.package_undeclared, kit.component_invalid), blocked (auth.scope_denied naming requiredKeys, workspace.schema_unsupported).'
	server.registerTool(
		'compose_product_kit',
		{
			title: 'Compose the UIUX Product Kit',
			description: `Set the Product Kit's external Design System packages (designSystems) and its Adapter specifiers and order. Needs product-kit.compose. Writes only the Product Kit file, with revision CAS; specifiers are checked against kit/ before anything is stored. Returns { status: "updated", revision, diagnostics, findings }. ${productKitRefusals}`,
			inputSchema: composeProductKitSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => productKitToolResult(await app.composeProductKit(input)),
	)

	server.registerTool(
		'update_product_kit',
		{
			title: 'Update the UIUX Product Kit settings',
			description: `Set the Adapters' config, the style entries (styles) and the theme root attributes (themes) of the Product Kit. Needs product-kit.write; the Adapter specifiers and order stay as they are (compose_product_kit changes them). Writes only the Product Kit file, with revision CAS. Returns { status: "updated", revision, diagnostics, findings }. ${productKitRefusals}`,
			inputSchema: updateProductKitSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => productKitToolResult(await app.updateProductKit({
			expectedRevision: input.expectedRevision,
			adapters: input.adapters.map(entry => ({ moduleSpecifier: entry.moduleSpecifier, ...(entry.config === undefined ? {} : { config: entry.config as JsonValue }) })),
			styles: input.styles,
			themes: input.themes as Record<string, Record<string, string>>,
		})),
	)

	server.registerTool(
		'update_component_registry',
		{
			title: 'Update the UIUX component registry',
			description: `Set the Product Kit's component registry (components) and component table (widgets). Needs product-kit.write. Every declared file must exist under kit/src/ and none may be a wrapper entry; each component's packages must be declared in kit/package.json; an entry that fails is refused with kit.component_invalid. A best-effort import scan returns findings (kit.component_invalid) for undeclared imports and unimported files without refusing. Writes only the Product Kit file, with revision CAS. Returns { status: "updated", revision, diagnostics, findings }. ${productKitRefusals}`,
			inputSchema: updateComponentRegistrySchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => productKitToolResult(await app.updateComponentRegistry({
			expectedRevision: input.expectedRevision,
			components: input.components as Record<string, ProductKitComponent>,
			widgets: input.widgets as Record<string, ProductKitWidgetMapping>,
		})),
	)

	// Clause 01a11be8-5b64-72b3-ad18-81994368a1ed; `product-kit.write` (Clause 01a11bb1-b35a-…). It takes
	// no command or argument: only kit/package.json decides what runs (Rule 01a11bb1-9d17-7205-abee-c2aa7058c107).
	server.registerTool(
		'restart_kit_build',
		{
			title: 'Restart the UIUX kit build',
			description: 'Stop the running kit build process, if any, and start the Workspace\'s kit build again, as kit/package.json declares it (uiux.build: its watch command, else its build command once). Takes no input: no command or argument can be supplied. Needs product-kit.write. Returns { status: "restarted", build: { state } } with state building, ready or failed, or { status: "no_build" } when kit/package.json declares no build. A call made while another restart is still queued shares the result of that restart. Read the build state later from uiux://product-kit. Refusals: blocked (auth.scope_denied naming requiredKeys, kit.build_unavailable when no kit build runs in this server, kit.build_restart_throttled within 2 s of the previous restart).',
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async () => {
			const result = await app.restartKitBuild()
			const output = result.status === 'blocked' ? result : { ...result, resourceUri: PRODUCT_KIT_RESOURCE_URI }
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(output) }],
				structuredContent: output,
				...(result.status === 'blocked' ? { isError: true } : {}),
			}
		},
	)

	// Rule 01a11bb1-a184-7e00-a8de-c81056ad5a35: the kit project is read-only in UIUX; these Tools
	// read it (Clauses 01a11bb1-b1c2-…, 01a11bb1-b227-… and 01a11bb1-b28f-…), each with
	// `product-kit.source.read` (Clause 01a11bb1-b35a-7e69-bba5-978e3f47c4fa).
	const kitFileTooLarge = 'too_large (kit.file_too_large: a kit file above 8 MiB, named by path, is not read)'
	const kitSourceBlocked = 'blocked (auth.scope_denied naming requiredKeys)'
	server.registerTool(
		'list_kit_files',
		{
			title: 'List the UIUX kit project files',
			description: `List the files of the kit project, the Workspace's kit/ directory: every regular file by its path relative to kit/, sorted by path, leaving out kit/node_modules/, every symbolic link and whatever lies below a linked directory. Read-only: kit code is changed outside UIUX. Takes no input. Needs product-kit.source.read. Returns { status: "listed", key: "product-kit", files: [{ path, size, resourceUri }], truncated }: at most 10000 files, truncated true when more were left out. Read a file from its resourceUri, uiux://product-kit/file/{path} with each / in path as %2F. Refusals: ${kitSourceBlocked}.`,
			inputSchema: z.object({}).strict(),
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async () => {
			const result = await app.listKitFiles()
			return kitSourceToolResult(result.status === 'listed' ? { ...result, files: result.files.map(file => ({ ...file, resourceUri: kitFileResourceUri(file.path) })) } : result, 'listed')
		},
	)

	server.registerTool(
		'get_component_source',
		{
			title: 'Get a UIUX component\'s source',
			description: `Return the source of a Product Kit registry component, for copying it into a product project yourself. Read-only. Needs product-kit.source.read. Returns { status: "found", key: "product-kit", components }: the named component, then, with withRequires, every component it requires, each { name, componentDigest, requires, packages, files, copyRecordEntry }. files are [{ path, digest, content }]: path relative to kit/, digest "sha256:" and the lowercase hex SHA-256 of the file's bytes, content the UTF-8 text, or base64 with encoding: "base64" when the bytes are not UTF-8. packages maps each external package the component declares to the version range kit/package.json gives it (null when it gives none); the product project needs them. Copy each file to its path relative to kit/src/ below one target directory of the product project, then write copyRecordEntry ({ componentDigest, exportedAt, files }) into the project's copy record, uiux-components.json ({ formatVersion: 1, components }), as components[name], adding target (that directory, relative to the project root) and prefixing each files key with target/. The digests are those uiux components add records, so uiux components diff and compare_component_copies read the entry. Refusals: not_found (the registry has no such component; components names it), invalid (kit.component_invalid when a declared file is not a regular file under kit/src/ reached without a symbolic link, or kit/package.json cannot be read; the Product Kit file's own validation), ${kitFileTooLarge}, ${kitSourceBlocked}.`,
			inputSchema: getComponentSourceSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => kitSourceToolResult(await app.getComponentSource({ name: input.name, ...(input.withRequires === undefined ? {} : { withRequires: input.withRequires }) }), 'found'),
	)

	server.registerTool(
		'compare_component_copies',
		{
			title: 'Compare UIUX component copies with the Workspace',
			description: `Return the Workspace side of the drift of copied components: for each file recorded in copies, whether its Workspace original still matches the recorded digest. Read-only. Needs product-kit.source.read. Returns { status: "compared", key: "product-kit", files: [{ component, path, source, recordedDigest, original, originalDigest }] }, sorted by component, then path. original is "matches"; "differs" when the original changed, is gone or is no longer declared by its component (originalDigest is its digest now, null when it cannot be read); or "removed" when the component is no longer in the registry (no originalDigest). To report drift as uiux components diff does, compare the digest of your copy at path with recordedDigest: removed is removed; a copy that is gone is missing; else a changed copy with an original that differs is diverged, a changed copy alone modified, an original that differs alone upstream, and neither unchanged. Refusals: invalid (the Product Kit file's own validation), ${kitFileTooLarge}, ${kitSourceBlocked}.`,
			inputSchema: compareComponentCopiesSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => kitSourceToolResult(await app.compareComponentCopies({ copies: input.copies }), 'compared'),
	)

	server.registerTool(
		'create_locale',
		{
			title: 'Create UIUX Locale',
			description: 'Create a canonical flat locale translation file named by a canonical BCP 47 tag. Fails if the locale already exists.',
			inputSchema: createLocaleSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('locale', await app.createLocale({
			locale: input.locale,
			messages: input.messages,
		})),
	)

	server.registerTool(
		'update_locale',
		{
			title: 'Update UIUX Locale',
			description: 'Update a canonical flat locale translation file with revision CAS. Fails on revision conflict or missing locale.',
			inputSchema: updateLocaleSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('locale', await app.updateLocale({
			locale: input.locale,
			expectedRevision: input.expectedRevision,
			messages: input.messages,
		})),
	)

	server.registerTool(
		'create_flow',
		{
			title: 'Create UIUX Flow',
			description: 'Create a canonical UX Flow with UUID identity, entry step, and step transition graph. Fails if the flow already exists.',
			inputSchema: createFlowSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('flow', await app.createFlow({
			...(input.id ? { id: input.id } : {}),
			name: input.name,
			...(input.scenarioRef ? { scenarioRef: input.scenarioRef as JsonObject } : {}),
			entryStepId: input.entryStepId,
			steps: input.steps as Record<string, FlowStep>,
		})),
	)

	server.registerTool(
		'update_flow',
		{
			title: 'Update UIUX Flow',
			description: 'Update a canonical UX Flow with revision CAS while preserving its immutable identity.',
			inputSchema: updateFlowSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('flow', await app.updateFlow({
			flowId: input.flowId,
			expectedRevision: input.expectedRevision,
			name: input.name,
			...(input.scenarioRef ? { scenarioRef: input.scenarioRef as JsonObject } : {}),
			entryStepId: input.entryStepId,
			steps: input.steps as Record<string, FlowStep>,
		})),
	)

	server.registerTool(
		'create_review_thread',
		{
			title: 'Create UIUX Review Thread',
			description: 'Create an initial open Review thread. Use anchor { scope: "workspace" } for feedback about the product as a whole; use { viewId, widgetId: "root" } for a whole View, or { viewId, widgetId } for one Widget, with optional variant scope. The optional displayHint.pin {x, y} is a non-authoritative pin position normalized (0..1) within the anchored Widget\'s rendered rect (Widget anchors only); agents have no pointer and should normally omit it. The optional renderContext { locale?, viewportId?, themeId? } records the Locale, viewport and theme the feedback was raised in (Widget anchors only); every key must exist in the Workspace (review.render_context_unknown_key otherwise).',
			inputSchema: createReviewThreadSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.createReviewThread({
			...(input.id ? { id: input.id } : {}),
			anchor: input.anchor as ReviewAnchor,
			...(input.variantNames ? { variantNames: input.variantNames } : {}),
			...(input.displayHint ? { displayHint: input.displayHint as ReviewDisplayHint } : {}),
			...(input.renderContext ? { renderContext: input.renderContext as ReviewRenderContext } : {}),
		})),
	)

	server.registerTool(
		'append_review_message',
		{
			title: 'Append UIUX Review Message',
			description: 'Append a new message to an existing Review thread with revision CAS.',
			inputSchema: appendReviewMessageSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.appendReviewMessage({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			...(input.actor !== undefined ? { actor: input.actor } : {}),
			body: input.body,
			...(input.id ? { id: input.id } : {}),
			...(input.at ? { at: input.at } : {}),
		})),
	)

	server.registerTool(
		'reanchor_review_thread',
		{
			title: 'Re-anchor UIUX Review Thread',
			description: 'Re-anchor a Review thread to a new widget or variant scope, or between a Widget and the Workspace ({ scope: "workspace" }), appending a re-anchor history event with revision CAS. displayHint: an object sets the pin hint for the new Widget anchor, null clears it, and omitting it clears the hint when the Widget changes and keeps it when only Variants change. Moving to the Workspace always clears the hint. renderContext: an object sets the recorded Locale, viewport and theme (each key must exist in the Workspace), null clears it, and omitting it keeps the recorded one; moving to the Workspace clears it, and an object there is refused (review.render_context_without_widget). The event records the context on both sides.',
			inputSchema: reanchorReviewThreadSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.reanchorReviewThread({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			anchor: input.anchor as ReviewAnchor,
			...(input.variantNames ? { variantNames: input.variantNames } : {}),
			...(input.displayHint !== undefined ? { displayHint: input.displayHint as ReviewDisplayHint | null } : {}),
			...(input.renderContext !== undefined ? { renderContext: input.renderContext as ReviewRenderContext | null } : {}),
			...(input.actor !== undefined ? { actor: input.actor } : {}),
			...(input.reason ? { reason: input.reason } : {}),
			...(input.id ? { id: input.id } : {}),
			...(input.at ? { at: input.at } : {}),
		})),
	)

	server.registerTool(
		'set_review_display_hint',
		{
			title: 'Set UIUX Review Display Hint',
			description: 'Move or clear the non-authoritative pin hint of a Review thread within the same Widget (displayHint.pin {x, y} normalized 0..1 within the anchored Widget\'s rendered rect, or null to clear) with revision CAS. Appends no history event and records no actor. Moving a pin to another Widget is reanchor_review_thread. Workspace-scoped threads have no pin and refuse (review.display_hint_without_widget).',
			inputSchema: setReviewDisplayHintSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.setReviewDisplayHint({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			displayHint: input.displayHint as ReviewDisplayHint | null,
		})),
	)

	server.registerTool(
		'submit_ready_for_review',
		{
			title: 'Submit UIUX Review Ready',
			description: 'Submit an immutable ready-for-review submission and lifecycle event with revision CAS. A Widget thread\'s resources must name its anchor View at the current revision. A Workspace thread\'s resources must name the current Workspace manifest revision ({ type: "workspace" }) and every View they name must be valid and current; formal_capture evidence must be complete for the current render input (IR and Variants) of a View named in resources, so a capture taken before a Spec-only or name edit still counts and one taken before an IR or Variant change does not (review.formal_evidence_not_current). A formal capture of unknown freshness, one that records no Adapter or Product Kit provenance or cited while the current one cannot be computed, is refused until it is recaptured (review.formal_evidence_freshness_unknown). Each evidenceRefs entry must cite a readable Evidence record of the kind it declares (review.evidence_not_record, review.evidence_kind_mismatch). changeDomains takes only the known values listed on it (review.change_domain_unknown).',
			inputSchema: submitReadyForReviewSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.submitReadyForReview({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			...(input.actor !== undefined ? { actor: input.actor } : {}),
			changeDomains: input.changeDomains,
			resources: input.resources as ReviewResourceRevision[],
			...(input.scope ? { scope: input.scope as JsonObject } : {}),
			evidenceRefs: input.evidenceRefs as ReviewEvidenceRef[],
			...(input.reason ? { reason: input.reason } : {}),
			...(input.id ? { id: input.id } : {}),
			...(input.at ? { at: input.at } : {}),
			...(input.submissionId ? { submissionId: input.submissionId } : {}),
		})),
	)

	server.registerTool(
		'resolve_review_thread',
		{
			title: 'Resolve UIUX Review Thread',
			description: RESOLVE_REVIEW_THREAD_DESCRIPTION,
			inputSchema: resolveReviewThreadSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.resolveReviewThread({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			...(input.resolution ? { resolution: input.resolution } : {}),
		})),
	)

	server.registerTool(
		'reopen_review_thread',
		{
			title: 'Reopen UIUX Review Thread',
			description: 'Reopen a resolved or ready Review thread back to open status with revision CAS.',
			inputSchema: reopenReviewThreadSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.reopenReviewThread({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			...(input.actor !== undefined ? { actor: input.actor } : {}),
			...(input.reason ? { reason: input.reason } : {}),
			...(input.id ? { id: input.id } : {}),
			...(input.at ? { at: input.at } : {}),
		})),
	)

	server.registerTool(
		'promote_review_to_decision',
		{
			title: 'Promote UIUX Review to Decision',
			description: 'Promote a Review thread to a View Spec Decision with provenance keying and idempotency. Workspace-scoped threads have no Decision home and refuse (review.decision_target_unavailable): re-anchor the thread to a View\'s root first.',
			inputSchema: promoteReviewToDecisionSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => {
			const outcome = await app.promoteReviewToDecision({
				reviewId: input.reviewId,
				expectedReviewRevision: input.expectedReviewRevision,
				viewId: input.viewId,
				expectedViewRevision: input.expectedViewRevision,
				question: input.question,
				...(input.outcome ? { outcome: input.outcome } : {}),
				...(input.actor !== undefined ? { actor: input.actor } : {}),
				...(input.decisionId ? { decisionId: input.decisionId } : {}),
			})
			if (outcome.status === 'created' || outcome.status === 'updated') {
				const output = {
					...outcome,
					resourceUri: pointResourceUri({ kind: 'review', key: outcome.key }),
					targetView: {
						key: input.viewId,
						revision: outcome.view?.revision ?? input.expectedViewRevision,
						resourceUri: pointResourceUri({ kind: 'view', key: input.viewId }),
					},
				}
				return {
					content: [{ type: 'text' as const, text: JSON.stringify(output) }],
					structuredContent: output,
				}
			}
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				isError: true,
			}
		},
	)

	server.registerTool(
		'edit_review_message',
		{
			title: 'Edit UIUX Review Message',
			description: 'Replace the text of your own Review message. The previous text is kept in the message\'s edit history. A message cannot be edited after a later ready-for-review submission or resolution; reply instead. Refusals: review.message_edit_not_author, review.message_frozen, review.message_body_empty, review.message_edit_noop, review.unknown_message.',
			inputSchema: editReviewMessageSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.editReviewMessage({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			messageId: input.messageId,
			body: input.body,
			...(input.editId ? { editId: input.editId } : {}),
			...(input.actor !== undefined ? { actor: input.actor } : {}),
			...(input.at ? { at: input.at } : {}),
		})),
	)

	server.registerTool(
		'retract_review_thread',
		{
			title: 'Retract UIUX Review Thread',
			description: 'Permanently delete your own brand-new Review thread: it must be open and contain only your one message, with no replies, history, submissions or promoted Decision. An empty thread with no messages may be retracted by any Reviewer. Once anyone has engaged, this always refuses (review.retract_engaged with a reason); the thread can then only be dismissed by a human. Returns { status: "deleted" }.',
			inputSchema: retractReviewThreadSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.retractReviewThread({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
		})),
	)

	server.registerTool(
		'create_asset',
		{
			title: 'Create UIUX Asset',
			description: 'Create an authored Asset with metadata and base64-encoded source content. Content is decoded and saved as native bytes.',
			inputSchema: createAssetSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('asset', await app.createAsset({
			...(input.id ? { id: input.id } : {}),
			name: input.name,
			contentFilename: input.contentFilename,
			mediaType: input.mediaType,
			contentBase64: input.contentBase64,
		})),
	)

	server.registerTool(
		'replace_asset',
		{
			title: 'Replace UIUX Asset',
			description: 'Replace an authored Asset with revision CAS while preserving its immutable identity. Content is decoded and saved as native bytes.',
			inputSchema: replaceAssetSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('asset', await app.replaceAsset({
			assetId: input.assetId,
			expectedRevision: input.expectedRevision,
			name: input.name,
			contentFilename: input.contentFilename,
			mediaType: input.mediaType,
			contentBase64: input.contentBase64,
		})),
	)

	server.registerTool(
		'capture_formal_evidence',
		{
			title: 'Capture formal evidence',
			description: 'Capture deterministic formal evidence and PNG screenshot artifacts for an explicit list of resolved render contexts.',
			inputSchema: captureFormalEvidenceSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => {
			const outcome = await app.captureFormalEvidence({
				contexts: input.contexts as ResolvedRenderContext[],
			})
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'failed' || outcome.status === 'blocked' ? { isError: true } : {}),
			}
		},
	)

	server.registerTool(
		'assess_handoff_readiness',
		{
			title: 'Assess Handoff Readiness',
			description: 'Assess dependency closure, validation, evidence, and review coverage for explicit Handoff roots without producing an exported bundle.',
			inputSchema: assessHandoffReadinessSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => {
			const outcome = await app.assessHandoffReadiness({
				roots: input.roots as HandoffRoot[],
			})
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'failed' || outcome.status === 'blocked' ? { isError: true } : {}),
			}
		},
	)

	server.registerTool(
		'get_version_diff',
		{
			title: 'Compare UIUX versions',
			description: 'Compare a version of the Workspace timeline with another version or with the current files. Returns { status: "compared", from, to, summary }, where summary lists each resource as added, removed, modified or unchanged; with detail "semantic" it adds changes, one semantic diff per resource that is not unchanged (Widgets by id, Variants, Spec items and Decisions for a View; steps for a Flow; message keys for a Locale; settings members for the Workspace, never schemaVersion; metadata and content digest for an Asset; JSON pointers otherwise). Refusals: history.invalid_comparison, history.record_missing (unknown version), workspace.schema_unsupported (a version recorded under a schemaVersion other than the current one, or a current Workspace at another schemaVersion).',
			inputSchema: getVersionDiffSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (input) => {
			const outcome = await app.diffVersions({
				from: input.from,
				...(input.to === undefined ? {} : { to: input.to }),
				...(input.resources === undefined ? {} : { resources: input.resources }),
				...(input.detail === undefined ? {} : { detail: input.detail }),
			})
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'compared' ? {} : { isError: true }),
			}
		},
	)

	server.registerTool(
		'list_versions',
		{
			title: 'List UIUX versions',
			description: 'List the Workspace version timeline (autosaves, Checkpoints, changes made outside UIUX as external versions, and system versions), newest first. Each version has id, type, name (Checkpoints), actor, at, parent (the ID of the version just before it on the full timeline, null for the first; it does not change with the filters) and summary, the resources whose revision differs from parent ({ kind, key, status }). Call get_version_diff with from set to a row\'s parent and to set to its id to see what that version changed, the same comparison the Workbench shows. Each version is also the read-only Resource uiux://version/{id}. Page with nextCursor. Refusals: history.invalid_listing, history.invalid_cursor.',
			inputSchema: listVersionsSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (input) => {
			const outcome = await app.listVersions({
				...(input.resource === undefined ? {} : { resource: input.resource }),
				...(input.types === undefined ? {} : { types: input.types }),
				...(input.limit === undefined ? {} : { limit: input.limit }),
				...(input.cursor === undefined ? {} : { cursor: input.cursor }),
			})
			const output = outcome.status === 'listed'
				? { ...outcome, versions: outcome.versions.map(version => ({ ...version, resourceUri: versionResourceUri(version.id) })) }
				: outcome
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(output) }],
				structuredContent: output,
				...(outcome.status === 'listed' ? {} : { isError: true }),
			}
		},
	)

	server.registerTool(
		'create_checkpoint',
		{
			title: 'Create UIUX Checkpoint',
			description: `Name the current state of the Workspace as a Checkpoint, a version kept until a human deletes it. Needs no edit lease and changes no design file; the open autosave closes first, and changes made outside UIUX are recorded before it. A Checkpoint is immutable: to correct one, create another. Returns { status: "created", versionId, at, resources }, resources being the number of resources it records. Refusals: history.invalid_checkpoint_name, history.invalid_checkpoint_note, workspace.schema_unsupported, history.boundary_failed (retryable). ${CHECKPOINT_RECOMMENDATION}`,
			inputSchema: createCheckpointSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async (input) => {
			const outcome = await app.createCheckpoint({ name: input.name, ...(input.note === undefined ? {} : { note: input.note }) })
			const output = outcome.status === 'created' ? { ...outcome, resourceUri: versionResourceUri(outcome.versionId) } : outcome
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(output) }],
				structuredContent: output,
				...(outcome.status === 'created' ? {} : { isError: true }),
			}
		},
	)

	server.registerTool(
		'restore_resource_version',
		{
			title: 'Restore a UIUX resource from a version',
			description: 'Write one design resource (a View, Flow, Locale, Asset, the Workspace settings or the Product Kit) back to its content in an earlier version, as a new current revision; history is never rewritten and there is no whole-version revert. It is a write of that resource: your edit lease is checked or taken, and expectedRevision is the resource\'s current revision (null to re-create a removed one). A View keeps its current Decisions; the settings keep the current schemaVersion. The content is validated like an authoring write. Before writing, the impact is analyzed (Review threads whose Widget anchor would become invalid or valid again, dangling $i18n and $asset references, UX Flow steps whose Widgets would disappear, ready-for-review submissions whose revision would stop or start being current, and for the settings removed viewport and theme keys and formal Evidence that would become stale); when it is not empty nothing is written and the result is impact_acknowledgement_required with impacts: call again with acknowledgeImpact true to write. The restore is recorded as its own version naming restoredFrom. Returns { status: "updated" | "created", kind, key, revision, restoredFrom, impacts, diagnostics }. Refusals: conflict (with currentRevision, null when the resource does not exist), locked, invalid (history.invalid_restore, history.restore_unsupported_kind, history.restore_invalid_content), impact_acknowledgement_required, not_found (history.record_missing, history.resource_not_in_version), blocked (workspace.schema_unsupported).',
			inputSchema: restoreResourceVersionSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async (input) => {
			// Rule 01a11c09-cbea-7341-9d5a-01719e9c5d94: the Access presets are changed over HTTP only.
			if (input.resource.kind === ACCESS_PRESETS_RESOURCE_KIND) {
				const message = 'The Access presets are read and changed over HTTP only, in the UIUX Workbench; MCP cannot restore them.'
				const refused = { status: 'invalid', kind: input.resource.kind, key: input.resource.key, code: 'history.restore_unsupported_kind', message, diagnostics: [{ code: 'history.restore_unsupported_kind', path: '/resource/kind', message }] }
				return { content: [{ type: 'text' as const, text: JSON.stringify(refused) }], structuredContent: refused, isError: true }
			}
			const outcome = await app.restoreResourceVersion({
				versionId: input.versionId,
				resource: input.resource,
				expectedRevision: input.expectedRevision,
				...(input.acknowledgeImpact === undefined ? {} : { acknowledgeImpact: input.acknowledgeImpact }),
			})
			const written = outcome.status === 'created' || outcome.status === 'updated'
			// As for every authoring tool, a written result adds the restored resource's URI.
			const output = outcome.status === 'created' || outcome.status === 'updated'
				? { ...outcome, resourceUri: outcome.kind === 'product-kit' ? PRODUCT_KIT_RESOURCE_URI : outcome.kind === ACCESS_PRESETS_RESOURCE_KIND ? undefined : pointResourceUri({ kind: outcome.kind, key: outcome.key }) }
				: outcome
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(output) }],
				structuredContent: output,
				...(written ? {} : { isError: true }),
			}
		},
	)

	server.registerTool(
		'export_handoff',
		{
			title: 'Export Handoff Bundle',
			description: 'Export an immutable Handoff manifest and complete dependency closure from explicit roots.',
			inputSchema: exportHandoffSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => {
			const outcome = await app.exportHandoff({
				roots: input.roots as HandoffRoot[],
			})
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'failed' || outcome.status === 'blocked' ? { isError: true } : {}),
			}
		},
	)

	server.registerTool(
		'acquire_lock',
		{
			title: 'Acquire UIUX edit leases',
			description: `Take (or renew) 5-minute edit leases on 1-${MAX_ACQUIRE_RESOURCES} resources, all or nothing. Lockable kinds: view, flow, locale, asset, workspace (key "workspace"), product-kit (key "product-kit"); Review threads are never locked. Returns { status: "acquired", leases } or { status: "locked", locks } naming each conflicting holder and expiry. ${LEASE_RECIPE}`,
			inputSchema: acquireLockSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (input) => {
			const outcome = app.acquireLeases(input)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'acquired' ? {} : { isError: true }),
			}
		},
	)

	server.registerTool(
		'release_lock',
		{
			title: 'Release UIUX edit leases',
			description: 'Release your edit leases on the listed resources, or all of them when resources is omitted. Idempotent: releasing what you do not hold is a no-op. Returns the released list.',
			inputSchema: releaseLockSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (input) => {
			const outcome = await app.releaseLeases(input)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'released' ? {} : { isError: true }),
			}
		},
	)

	return server
}

/**
 * Every tool and resource callback registered on `server` answers a persistence lock timeout with
 * the coded, retryable `persistence.busy` instead of an opaque failure: a tool returns it as an
 * error result (`structuredContent.code`), a resource read as a JSON-RPC internal error whose data
 * is the same result.
 */
function mapPersistenceBusy(server: McpServer): McpServer {
	type Callback = (...args: unknown[]) => unknown
	const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => unknown
	const registerResource = server.registerResource.bind(server) as (...args: unknown[]) => unknown
	const guard = (callback: Callback, onBusy: () => unknown): Callback => async (...args) => {
		try {
			return await callback(...args)
		}
		catch (error) {
			if (!isPersistenceBusyError(error)) throw error
			return onBusy()
		}
	}
	server.registerTool = ((...args: unknown[]) => {
		const callback = args.pop() as Callback
		return registerTool(...args, guard(callback, () => {
			const busy = persistenceBusyResult()
			return { content: [{ type: 'text' as const, text: JSON.stringify(busy) }], structuredContent: busy, isError: true }
		}))
	}) as typeof server.registerTool
	server.registerResource = ((...args: unknown[]) => {
		const callback = args.pop() as Callback
		return registerResource(...args, guard(callback, () => {
			const busy = persistenceBusyResult()
			throw new ProtocolError(ProtocolErrorCode.InternalError, `${busy.code}: ${busy.message}`, busy)
		}))
	}) as typeof server.registerResource
	return server
}

export const RESOLVE_REVIEW_THREAD_DESCRIPTION = 'Resolution is human-only and happens in the UIUX Workbench. This tool always refuses. Reply on the thread, or submit it ready for review, and a human will resolve it.'

/** The `authInfo.extra` key carrying the verified principal from the route into the per-request factory. */
export const PRINCIPAL_AUTH_INFO_KEY = 'uiuxPrincipal'

export function principalFromAuthInfo(authInfo: AuthInfo | undefined): Principal | undefined {
	const candidate = authInfo?.extra?.[PRINCIPAL_AUTH_INFO_KEY] as Principal | undefined
	return candidate && (candidate.type === 'member' || candidate.type === 'system') ? candidate : undefined
}

/** `authInfo` for a verified principal: the plaintext token is never handed to the SDK (`token: "<redacted>"`). */
export function principalAuthInfo(principal: Principal): AuthInfo {
	return {
		token: '<redacted>',
		clientId: principal.type === 'member' ? principal.memberId : principal.id,
		scopes: [...effectiveKeys(principal)],
		extra: { [PRINCIPAL_AUTH_INFO_KEY]: principal },
	}
}

/**
 * Stateless per-request MCP handler. The caller verifies the bearer token first and passes the
 * principal through `fetch(request, { authInfo })`; a request without one is answered 401 here
 * too, so no code path can reach a tool unauthenticated.
 */
export function createUiuxMcpHttpHandler(app: WorkspaceApplicationSession, options: Readonly<{ leases: LeaseManager; history?: ScopedSessionOptions['history'] }>): McpHttpHandler {
	const inner = createMcpHandler((ctx) => {
		const principal = principalFromAuthInfo(ctx.authInfo)
		if (!principal || principal.type !== 'member') throw new Error('MCP request reached the server factory without an authenticated member.')
		return createUiuxMcpServer(createScopedWorkspaceSession(app, principal, { transport: 'mcp', leases: options.leases, ...(options.history ? { history: options.history } : {}) }))
	})
	return {
		...inner,
		fetch: async (request, requestOptions) => {
			const principal = principalFromAuthInfo(requestOptions?.authInfo)
			if (!principal || principal.type !== 'member') {
				const message = 'MCP requires a member bearer token. Create a token with `uiux token create --workspace <dir> --member <agent>` and send it as `Authorization: Bearer <token>`.'
				return new Response(JSON.stringify({ status: 'rejected', code: 'auth.required', message, diagnostics: [{ code: 'auth.required', path: '/headers/authorization', message }] }), {
					status: 401,
					headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="uiux"', 'cache-control': 'no-store' },
				})
			}
			return inner.fetch(request, requestOptions)
		},
	}
}

async function resourceResult(app: ScopedWorkspaceSession, uri: URL): Promise<ReadResourceResult> {
	const address = parsePointResourceUri(uri)
	if (!address) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unsupported UIUX resource URI: ${uri.href}`)
	const read = await app.readPointResource(address.kind, address.key)
	if (!read) throw new ResourceNotFoundError(uri.href, `UIUX resource not found: ${uri.href}`)
	return {
		contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(read) }],
	}
}

async function discoveryToolResult(app: ScopedWorkspaceSession, mode: 'list' | 'search', input: unknown) {
	const outcome = mode === 'list' ? await app.listPointResources(input) : await app.searchPointResources(input)
	if (outcome.status === 'invalid')
		throw new ProtocolError(ProtocolErrorCode.InvalidParams, outcome.diagnostics.map(item => `${item.path || '/'}: ${item.message}`).join('; '))
	const output = {
		items: outcome.page.items.map(item => ({ ...item, resourceUri: pointResourceUri({ kind: item.kind, key: item.key }) })),
		...(outcome.page.nextCursor ? { nextCursor: outcome.page.nextCursor } : {}),
	}
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(output) }],
		structuredContent: output,
	}
}

function kitSourceToolResult(result: { status: string; [key: string]: unknown }, succeeded: string) {
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(result) }],
		structuredContent: result,
		...(result.status === succeeded ? {} : { isError: true }),
	}
}

function productKitToolResult(result: { status: string; key: string; [key: string]: unknown }) {
	const output = result.status === 'updated' ? { ...result, resourceUri: PRODUCT_KIT_RESOURCE_URI } : result
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(output) }],
		structuredContent: output,
		...(result.status === 'updated' ? {} : { isError: true }),
	}
}

function authoringToolResult(kind: PointResourceKind, result: { status: string; key: string; [key: string]: unknown }) {
	const output = result.status === 'created' || result.status === 'updated'
		? { ...result, resourceUri: pointResourceUri({ kind, key: result.key }) }
		: result
	const succeeded = result.status === 'created' || result.status === 'updated' || result.status === 'deleted'
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(output) }],
		structuredContent: output,
		...(succeeded ? {} : { isError: true }),
	}
}
