import type { ViewResource } from '../../src/domain/views/schema'
import type { WorkspaceManifest } from '../../src/domain/workspace/schema'
import type { ReviewDisplayHint, ReviewResolution } from '../../src/domain/reviews/schema'

export type Diagnostic = Readonly<{ code: string; path: string; message: string }>

export type WorkspaceRead = Readonly<{
	kind: 'workspace'
	key: 'workspace'
	revision: string
	diagnostics: readonly Diagnostic[]
	resource: WorkspaceManifest
	/** Schema-policy state of the opened manifest; `migration_required` blocks every mutation. */
	inspection?: Readonly<{ state: 'current' | 'migration_required' | 'unsupported' | 'missing_manifest'; version?: number; targetVersion: number }>
}>

export type ViewSummary = Readonly<{
	kind: 'view'
	key: string
	revision: string
	diagnosticCount: number
	summary: { name?: string; feature?: string }
}>

export type LocaleSummary = Readonly<{ kind: 'locale'; key: string; revision: string }>

export type FlowSummary = Readonly<{
	kind: 'flow'
	key: string
	revision: string
	diagnosticCount: number
	summary: { name?: string }
}>

export type ReviewSummary = Readonly<{
	kind: 'review'
	key: string
	revision: string
	diagnosticCount: number
	summary: {
		anchor?: Readonly<{ viewId: string; widgetId: string }>
		/** Anchor Variant scope; `[]` means View-wide. */
		variantNames?: readonly string[]
		/** Non-authoritative pin placement, normalized 0..1 within the anchored Widget's rect. */
		displayHint?: ReviewDisplayHint
		status?: 'open' | 'ready-for-review' | 'resolved'
		/** Derived from the final lifecycle event while resolved. */
		resolution?: ReviewResolution
		messageCount?: number
		/** Latest canonical activity (newest message, submission or history event), ISO 8601. */
		latestActivityAt?: string
	}
}>

export type DecisionRead = Readonly<{
	id: string
	question: string
	status: 'pending' | 'deferred' | 'decided'
	outcome?: Readonly<{ summary: string; rationale: string }>
	history: readonly unknown[]
}>

export type ReferenceRead = Readonly<{
	type: string
	uri: string
	label?: string
	relation?: string
}>

export type ViewRead = Readonly<{
	kind: 'view'
	key: string
	revision: string
	diagnostics: readonly Diagnostic[]
	resource: ViewResource & {
		spec: {
			intent: string
			entryConditions: readonly string[]
			interactionRules: readonly string[]
			constraints: readonly string[]
			accessibility: readonly string[]
			references: readonly ReferenceRead[]
			decisions: readonly DecisionRead[]
		}
	}
}>

/** Right-panel tabs of a View page (brief e). */
export type ViewPanelTab = 'comments' | 'inspect' | 'spec' | 'readiness'

/** Render context carried in a View deep link (`/views/:id?variant=&locale=&viewport=&theme=&widget=`). */
export type ViewRouteContext = Readonly<{
	variant: string
	locale: string
	viewport: string
	theme: string
	widget: string
}>

/** Preview session handshake state; `idle` means no View is mounted, so no session is expected. */
export type SessionPhase = 'idle' | 'initiating' | 'open' | 'failed'

export type EvidenceContextSelection = Readonly<{
	viewId: string
	variantName?: string
	locale: string
	viewportId: string
	themeId: string
}>
