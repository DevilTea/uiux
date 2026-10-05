import { computed } from 'vue'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from './useMediaQuery'
import { useWorkbench } from './useWorkbench'

/**
 * Who may edit on the Workspace authoring pages (brief g, section 7):
 * - `edit`: a live server on a desktop-width window (≥ 1280px);
 * - `tablet`: 768–1279px, read-only with an "Edit on desktop" hint;
 * - `mobile`: under 768px, read-only lists;
 * - `publication`: a published snapshot, read-only with authoring controls hidden;
 * - `migration`: an older Workspace schema, read-only until `uiux migrate` runs.
 */
export type AuthoringAccess = 'edit' | 'tablet' | 'mobile' | 'publication' | 'migration'

const MOBILE_MIN = '(min-width: 768px)'

export function useAuthoringAccess() {
	const { isReadOnly, workspace } = useWorkbench()
	const desktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
	const atLeastTablet = useMediaQuery(MOBILE_MIN)

	const access = computed<AuthoringAccess>(() => {
		if (isReadOnly.value) return 'publication'
		if (workspace.value?.inspection?.state === 'migration_required') return 'migration'
		if (desktop.value) return 'edit'
		return atLeastTablet.value ? 'tablet' : 'mobile'
	})

	return {
		access,
		canEdit: computed(() => access.value === 'edit'),
		isMobile: computed(() => !atLeastTablet.value),
	}
}
