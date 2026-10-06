import type { DropdownMenuItem } from '@nuxt/ui'
import type { ReviewResolution, ReviewStatus } from '../../src/domain/reviews/schema'
import { DISMISS_RESOLUTIONS } from './review-inbox'

/**
 * The Resolve menu, grouped (retract addendum decision 11; presentation only, the resolution enum
 * is unchanged): **Resolve** holds Answered and, on a ready thread, Verified (it accepts the
 * active submission); **Dismiss** holds No longer relevant, Duplicate… and Won't do. The one-click
 * primary button keeps its meaning (Answered on `open`, Accept & resolve on `ready-for-review`).
 */
export type ResolveMenuOptions = Readonly<{
	t: (key: string, values?: Record<string, unknown>) => string
	status: ReviewStatus
	/** A ready thread with an active submission can be resolved as verified. */
	canVerify: boolean
	resolve: (resolution: ReviewResolution) => void
	/** Duplicate asks for a reason first. */
	askDuplicate: () => void
}>

const DISMISS_ICONS: Readonly<Record<string, string>> = {
	'obsolete': 'i-lucide-archive',
	'duplicate': 'i-lucide-copy',
	'wont-fix': 'i-lucide-circle-slash',
}

export function resolveMenuGroups(options: ResolveMenuOptions): DropdownMenuItem[][] {
	const { t } = options
	const resolveGroup: DropdownMenuItem[] = [
		{ type: 'label', label: t('comments.resolveGroup') },
		{ label: t('comments.resolution.answered'), icon: 'i-lucide-message-circle-reply', onSelect: () => options.resolve('answered'), 'data-resolve-kind': 'answered' },
		...(options.status === 'ready-for-review'
			? [{ label: t('comments.resolution.verified'), icon: 'i-lucide-badge-check', disabled: !options.canVerify, onSelect: () => options.resolve('verified'), 'data-resolve-kind': 'verified' }]
			: []),
	]
	const dismissGroup: DropdownMenuItem[] = [
		{ type: 'label', label: t('comments.dismissGroup') },
		...DISMISS_RESOLUTIONS.map(resolution => ({
			label: resolution === 'duplicate' ? t('comments.resolveDuplicate') : t(`comments.resolution.${resolution}`),
			icon: DISMISS_ICONS[resolution],
			onSelect: () => resolution === 'duplicate' ? options.askDuplicate() : options.resolve(resolution),
			'data-resolve-kind': resolution,
		})),
	]
	return [resolveGroup, dismissGroup]
}
