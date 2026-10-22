import { useI18n } from '#imports'

import type { ReviewActor } from '../../src/domain/reviews/schema'

/**
 * The display name of a Review actor as recorded, marked "(removed)" when the server flagged the
 * actor `removed: true` because its member left the roster (Rule 01a11485-f185-7c23-8f2a-e045a279cd27).
 * The server adds the flag to every Review read, so every role sees it.
 */
export function useActorName() {
	const { t } = useI18n()
	return function actorName(actor: ReviewActor | undefined): string {
		const name = actor?.displayName ?? actor?.id ?? t('comments.unknownAuthor')
		return actor?.removed ? t('comments.removedMember', { name }) : name
	}
}
