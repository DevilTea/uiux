import { computed, toValue, type MaybeRefOrGetter } from 'vue'
import type { LockableKind } from '../../src/application/access/leases'
import { useAccess } from './useAccess'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from './useMediaQuery'
import { useWorkbench } from './useWorkbench'

/**
 * Who may edit on the Workspace authoring pages (brief g, section 7; accepted identity decision 12):
 * - `edit`: a live server on a desktop-width window (≥ 1280px), signed in as Editor or above;
 * - `tablet`: 768–1279px, read-only with an "Edit on desktop" hint;
 * - `mobile`: under 768px, read-only lists;
 * - `migration`: an older Workspace schema, read-only until `uiux migrate` runs;
 * - `role`: the signed-in member is below Editor, read-only and naming the role required;
 * - `locked`: someone else (an agent) holds the edit lease on the page's resource, read-only
 *   beside the Lock badge until the lease is released or expires.
 */
export type AuthoringAccess = 'edit' | 'tablet' | 'mobile' | 'migration' | 'role' | 'locked'

export type AuthoringLockTarget = Readonly<{ kind: LockableKind; key: string }>

const MOBILE_MIN = '(min-width: 768px)'

export function useAuthoringAccess(lockTarget?: MaybeRefOrGetter<AuthoringLockTarget | undefined>) {
	const { authorReadOnly, workspace } = useWorkbench()
	const member = useAccess()
	const desktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
	const atLeastTablet = useMediaQuery(MOBILE_MIN)

	const access = computed<AuthoringAccess>(() => {
		if (workspace.value?.inspection?.state === 'migration_required') return 'migration'
		if (authorReadOnly.value) return 'role'
		const target = toValue(lockTarget)
		if (target && member.lockFor(target.kind, target.key)) return 'locked'
		if (desktop.value) return 'edit'
		return atLeastTablet.value ? 'tablet' : 'mobile'
	})

	return {
		access,
		canEdit: computed(() => access.value === 'edit'),
		isMobile: computed(() => !atLeastTablet.value),
	}
}
