import { computed } from 'vue'
import { useI18n } from '#imports'
import { useAccess } from './useAccess'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from './useMediaQuery'
import { useWorkbench } from './useWorkbench'

const AT_LEAST_TABLET = '(min-width: 768px)'

/**
 * Where the Workbench offers the Checkpoint actions (accepted R34 device tiers):
 * - Create Checkpoint on desktop and tablet, never on a phone in either orientation (Rule
 *   01a11a5e-1ba5-765e-966f-a681def5f472; a handset is a phone width or a short touch screen, as for
 *   canvas comments),
 *   for a holder of `checkpoints.create` on a live, migrated Workspace (the server's check stays
 *   the authority);
 * - Delete Checkpoint on desktop only (Rule 01a11e0d-dada-7f49-a4a0-5b45d70b23e8), for a holder of
 *   `checkpoints.delete`, a `humanOnly` key the session holds only for a person signed in to the
 *   Workbench (Rule 01a11c09-bec8-7dee-971a-4c10eaf83eef).
 */
export function useCheckpointAccess() {
	const { t } = useI18n()
	const { canWrite, writeBlocked } = useWorkbench()
	const access = useAccess()
	const desktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
	const atLeastTablet = useMediaQuery(AT_LEAST_TABLET)
	const handset = useMediaQuery(WORKBENCH_BREAKPOINTS.handset)

	/** Offered at all on this layout. */
	const createOffered = computed(() => atLeastTablet.value && !handset.value)
	/** Why the signed-in member cannot create one here; undefined when they can. */
	const createBlockedReason = computed(() => {
		if (writeBlocked.value) return t('history.checkpoint.blockedMigration')
		if (!canWrite('checkpoints.create')) return t('access.requiresKey', { key: 'checkpoints.create' })
		return undefined
	})
	const canCreate = computed(() => createOffered.value && !createBlockedReason.value)
	const canDelete = computed(() => desktop.value && access.can('checkpoints.delete'))

	return { createOffered, createBlockedReason, canCreate, canDelete }
}
