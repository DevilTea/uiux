import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { PermissionKey } from '../../src/application/access/keys'
import type { LockableKind } from '../../src/application/access/leases'
import { useAccess } from './useAccess'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from './useMediaQuery'
import { useWorkbench } from './useWorkbench'

/**
 * Who may edit on a Workspace authoring page (brief g, section 7; Rule
 * 01a11485-eba3-7c07-a94f-0d69e610a0b6: each page checks its own key):
 * - `edit`: a live server on a desktop-width window (≥ 1280px), signed in with the page's write key;
 * - `tablet`: 768–1279px, read-only with an "Edit on desktop" hint;
 * - `mobile`: under 768px, read-only lists;
 * - `migration`: an older Workspace schema, read-only until `uiux migrate` runs;
 * - `key`: the signed-in member lacks the page's write key, read-only and naming it (`writeKey`);
 * - `locked`: someone else (an agent) holds the edit lease on the page's resource, read-only
 *   beside the Lock badge until the lease is released or expires.
 */
export type AuthoringAccess = 'edit' | 'tablet' | 'mobile' | 'migration' | 'key' | 'locked'

export type AuthoringLockTarget = Readonly<{ kind: LockableKind; key: string }>

const MOBILE_MIN = '(min-width: 768px)'

export function useAuthoringAccess(writeKey: PermissionKey, lockTarget?: MaybeRefOrGetter<AuthoringLockTarget | undefined>) {
	const { canWrite, workspace } = useWorkbench()
	const member = useAccess()
	const desktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
	const atLeastTablet = useMediaQuery(MOBILE_MIN)

	const access = computed<AuthoringAccess>(() => {
		if (workspace.value?.inspection?.state === 'migration_required') return 'migration'
		if (!member.can(writeKey)) return 'key'
		// A Workspace this build cannot write at all (`unsupported`) is read-only like an unmigrated one.
		if (!canWrite(writeKey)) return 'migration'
		const target = toValue(lockTarget)
		if (target && member.lockFor(target.kind, target.key)) return 'locked'
		if (desktop.value) return 'edit'
		return atLeastTablet.value ? 'tablet' : 'mobile'
	})

	return {
		access,
		/** The page's write key, which the `key` state names. */
		writeKey,
		canEdit: computed(() => access.value === 'edit'),
		isMobile: computed(() => !atLeastTablet.value),
	}
}
