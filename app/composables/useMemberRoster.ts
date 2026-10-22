import { readonly, shallowRef } from 'vue'
import { useI18n } from '#imports'

import type { ReviewActor } from '../../src/domain/reviews/schema'

/**
 * Which `member:<uuid>` actors are still on the roster, so the Workbench can label Review records
 * written by a removed member (Rule 01a11485-f185-7c23-8f2a-e045a279cd27). History is never
 * rewritten: the record keeps its actor and recorded display name, and the label is added at read
 * time only.
 *
 * Only a holder of `members.manage` may read the roster (`GET /api/access/members`), so only that
 * member's Workbench can tell: anyone else, and any session whose roster read was refused, sees the
 * recorded display name unmarked. A record without a stamped `member:` actor (written before
 * stamping, or caller-asserted) is never labelled removed.
 */
const MEMBER_PREFIX = 'member:'

const memberIds = shallowRef<ReadonlySet<string>>()

/** Reads the roster's member IDs; a refused or failed read forgets them, so nothing is marked. */
export async function refreshMemberRoster(): Promise<void> {
	try {
		const roster = await $fetch<{ members: readonly { id: string }[] }>('/api/access/members', { cache: 'no-store' })
		memberIds.value = new Set(roster.members.map(member => member.id))
	}
	catch {
		memberIds.value = undefined
	}
}

export function clearMemberRoster(): void {
	memberIds.value = undefined
}

/** True when a stamped `member:<uuid>` actor is known to be off the roster. */
export function isRemovedActor(actor: Pick<ReviewActor, 'id'> | undefined, ids: ReadonlySet<string> | undefined = memberIds.value): boolean {
	const id = actor?.id
	return !!ids && typeof id === 'string' && id.startsWith(MEMBER_PREFIX) && !ids.has(id.slice(MEMBER_PREFIX.length))
}

export function useMemberRoster() {
	const { t } = useI18n()

	/** The display name for an actor, marked "(removed)" when the member left the roster. */
	function actorName(actor: ReviewActor | undefined): string {
		const name = actor?.displayName ?? actor?.id ?? t('comments.unknownAuthor')
		return actor && isRemovedActor(actor) ? t('comments.removedMember', { name }) : name
	}

	return { memberIds: readonly(memberIds), isRemoved: isRemovedActor, actorName }
}
