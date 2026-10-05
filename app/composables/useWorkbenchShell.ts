import { computed, inject, provide, ref, shallowRef, type InjectionKey } from 'vue'
import { defineShortcuts, navigateTo, useColorMode, useI18n } from '#imports'
import { isWorkbenchLocale, saveWorkbenchLocale } from '../utils/workbench-locale'

/**
 * Shell-level UI state shared by the navbar, sidebar, pages, command palette and keyboard
 * shortcuts (brief a, sections 7 and 9). Nothing here is canonical Workspace data.
 */
export type WorkbenchShell = ReturnType<typeof createWorkbenchShell>

/** What the open View canvas offers the command palette (brief b, section 9). */
export type CanvasCommands = Readonly<{
	fit: () => void
	zoomIn: () => void
	zoomOut: () => void
	actualSize: () => void
	selectTool: (tool: 'select' | 'comment' | 'interact') => void
	/** False where the Comment tool is not offered (Viewer role, publication, phones). */
	canComment: () => boolean
}>

const SHELL_KEY: InjectionKey<WorkbenchShell> = Symbol('uiux-workbench-shell')
const SINGLE_KEY_STORAGE_KEY = 'uiux.workbench.singleKeyShortcuts'

function readSingleKeyPreference(): boolean {
	try { return globalThis.localStorage?.getItem(SINGLE_KEY_STORAGE_KEY) !== 'off' }
	catch { return true }
}

/** Landmarks cycled by F6 / Shift+F6, in reading order. */
const LANDMARK_ORDER = ['navigation', 'main', 'complementary', 'banner'] as const

function createWorkbenchShell() {
	const colorMode = useColorMode()
	const { locale, setLocale } = useI18n()

	const searchOpen = ref(false)
	const shortcutsOpen = ref(false)
	const singleKeyShortcuts = ref(readSingleKeyPreference())
	let toggleSidebarHandler: (() => void) | undefined
	let toggleRightPanelHandler: (() => void) | undefined
	const canvasCommands = shallowRef<CanvasCommands>()

	function setSingleKeyShortcuts(enabled: boolean): void {
		singleKeyShortcuts.value = enabled
		try { globalThis.localStorage?.setItem(SINGLE_KEY_STORAGE_KEY, enabled ? 'on' : 'off') }
		catch { /* storage unavailable */ }
	}

	/** Workbench chrome only: never the previewed View's theme. */
	function toggleWorkbenchTheme(): void {
		colorMode.preference = colorMode.value === 'dark' ? 'light' : 'dark'
	}

	/** Workbench chrome only: never the previewed View's Locale. */
	function switchWorkbenchLanguage(): void {
		const next = locale.value === 'zh-TW' ? 'en-US' : 'zh-TW'
		if (!isWorkbenchLocale(next)) return
		saveWorkbenchLocale(next)
		void setLocale(next)
	}

	function cycleLandmark(direction: 1 | -1): void {
		const landmarks = LANDMARK_ORDER
			.map(role => document.querySelector<HTMLElement>(`[data-landmark="${role}"]`))
			.filter((element): element is HTMLElement => !!element && element.getClientRects().length > 0)
		if (!landmarks.length) return
		const current = landmarks.findIndex(element => element.contains(document.activeElement))
		const next = landmarks[(current + direction + landmarks.length) % landmarks.length]!
		if (!next.hasAttribute('tabindex')) next.setAttribute('tabindex', '-1')
		next.focus()
	}

	defineShortcuts(computed(() => ({
		'meta_.': toggleWorkbenchTheme,
		'f6': { usingInput: true, handler: () => cycleLandmark(1) },
		'shift_f6': { usingInput: true, handler: () => cycleLandmark(-1) },
		...(singleKeyShortcuts.value
			? {
					'g-o': () => navigateTo('/'),
					'g-v': () => navigateTo('/views'),
					'g-f': () => navigateTo('/flows'),
					'g-r': () => navigateTo('/reviews'),
					'[': () => toggleSidebarHandler?.(),
					']': () => toggleRightPanelHandler?.(),
					'?': () => { shortcutsOpen.value = true },
				}
			: {}),
	})))

	return {
		searchOpen,
		shortcutsOpen,
		singleKeyShortcuts,
		setSingleKeyShortcuts,
		toggleWorkbenchTheme,
		switchWorkbenchLanguage,
		onToggleSidebar: (handler: () => void) => { toggleSidebarHandler = handler },
		/** Pages with a right panel register how `]` toggles it. */
		onToggleRightPanel: (handler: (() => void) | undefined) => { toggleRightPanelHandler = handler },
		/** The mounted canvas registers its zoom and tool commands; `undefined` on unmount. */
		onCanvasCommands: (commands: CanvasCommands | undefined) => { canvasCommands.value = commands },
		canvasCommands,
		toggleSidebar: () => toggleSidebarHandler?.(),
	}
}

export function provideWorkbenchShell(): WorkbenchShell {
	const shell = createWorkbenchShell()
	provide(SHELL_KEY, shell)
	return shell
}

export function useWorkbenchShell(): WorkbenchShell {
	const shell = inject(SHELL_KEY)
	if (!shell) throw new Error('useWorkbenchShell() must be used below provideWorkbenchShell().')
	return shell
}
