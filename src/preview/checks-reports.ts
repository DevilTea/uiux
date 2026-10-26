import type { ChecksReportMessage, ChecksRuntimeError, ChecksTranslationWarning } from './protocol/checks-report'

/**
 * What the Workbench holds of the live Preview for Checks (owner ruling 1 of 2026-10-26,
 * Discussion #241; issue #347; Clauses 01a17619-89fc-7a94-b690-2e65c6a99f39 and
 * 01a17619-ab3f-797d-ae93-4038a48ee31f): the latest accepted `checks.report` of the current
 * generation, as a view model. It is a Workbench state, never a wire shape.
 */
export type LivePreviewChecks = Readonly<{
	runtimeGenerationId: string
	/** The View and Variant the report is about. */
	viewId: string
	variantId?: string
	runtimeContextVersion: number
	sequence: number
	/** Only the warnings of the Locale the Workbench renders. */
	translationWarnings: readonly ChecksTranslationWarning[]
	runtimeErrors: readonly ChecksRuntimeError[]
}>

/** What the Workbench renders now: the context a report must match to be current. */
export type ChecksRenderingContext = Readonly<{
	runtimeGenerationId: string
	viewId: string
	variantId?: string
	/** The Locale of the render context; a warning for another Locale is of an earlier one. */
	locale?: string
}>

export type ChecksReportAcceptance =
	| Readonly<{ status: 'accepted' }>
	/** The report is not about the View, Variant, generation or runtime context the Workbench renders. */
	| Readonly<{ status: 'stale-context' }>
	/** A report with a higher `sequence`, or a later context, was accepted already. */
	| Readonly<{ status: 'stale-sequence' }>

/**
 * The latest accepted report of one runtime generation. A higher `sequence` replaces the held
 * report as a whole (a report is complete, never a delta); a report of another View or Variant than
 * the one rendered, of an earlier runtime context or of another generation is dropped. The
 * `sequence` and context floors survive `clear`, so a report that was in flight when the Workbench
 * changed context is still judged against everything accepted before it; `reset` starts a new
 * generation.
 */
export class PreviewChecksReports {
	private held?: LivePreviewChecks
	private lastSequence?: number
	private lastContextVersion?: number

	accept(message: ChecksReportMessage, rendering: ChecksRenderingContext): ChecksReportAcceptance {
		const { context, payload } = message
		if (context.runtimeGenerationId !== rendering.runtimeGenerationId
			|| context.viewId !== rendering.viewId
			|| (context.variantId ?? '') !== (rendering.variantId ?? '')) return { status: 'stale-context' }
		if (this.lastContextVersion !== undefined && context.runtimeContextVersion < this.lastContextVersion) return { status: 'stale-context' }
		if (this.lastSequence !== undefined && payload.sequence <= this.lastSequence) return { status: 'stale-sequence' }
		this.lastSequence = payload.sequence
		this.lastContextVersion = context.runtimeContextVersion
		this.held = Object.freeze({
			runtimeGenerationId: context.runtimeGenerationId,
			viewId: context.viewId,
			...(context.variantId !== undefined ? { variantId: context.variantId } : {}),
			runtimeContextVersion: context.runtimeContextVersion,
			sequence: payload.sequence,
			// A warning names the Locale it was requested for: one of another Locale than the one rendered
			// is the earlier context's (Rule 01a115cd-b9fc-71d9-8bf9-91d65acd1096), whatever the report says.
			translationWarnings: rendering.locale === undefined
				? payload.translationWarnings
				: payload.translationWarnings.filter(entry => entry.warning.requestedLocale === rendering.locale),
			runtimeErrors: payload.runtimeErrors,
		})
		return { status: 'accepted' }
	}

	/** The report held now, if any. */
	current(): LivePreviewChecks | undefined {
		return this.held
	}

	/** The Workbench changed the View, Variant or Locale: the held report is of the previous context. */
	clear(): void {
		this.held = undefined
	}

	/** The generation ended or was replaced: nothing of it carries over, not even its floors. */
	reset(): void {
		this.held = undefined
		this.lastSequence = undefined
		this.lastContextVersion = undefined
	}
}
