import type { ReviewRenderContext } from '../../src/domain/reviews/schema'
import { RENDER_CONTEXT_MEMBERS, type MissingRenderContextKey, type RenderContextMember } from '../../src/preview/render-context-options'

/** One recorded member as a thread header shows it, flagged when its key no longer exists. */
export type RecordedContextPart = Readonly<{ member: RenderContextMember; key: string; missing: boolean }>

/**
 * The members a thread records, in header order (Locale · viewport · theme), for the label such as
 * "zh-TW · mobile · dark" (Rule 01a1170f-c11d). Unrecorded members are left out.
 */
export function recordedContextParts(recorded: ReviewRenderContext | undefined, missing: readonly MissingRenderContextKey[] = []): readonly RecordedContextPart[] {
	if (!recorded) return []
	const stale = new Set(missing.map(item => `${item.member}:${item.key}`))
	return RENDER_CONTEXT_MEMBERS.flatMap((member) => {
		const key = recorded[member]
		return key === undefined ? [] : [Object.freeze({ member, key, missing: stale.has(`${member}:${key}`) })]
	})
}

/** The plain label text, e.g. "zh-TW · mobile · dark". */
export function recordedContextText(parts: readonly RecordedContextPart[]): string {
	return parts.map(part => part.key).join(' · ')
}
