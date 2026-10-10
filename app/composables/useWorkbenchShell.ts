import { computed, inject, provide, ref, shallowRef, type InjectionKey } from 'vue'
import { defineShortcuts, navigateTo, useColorMode, useI18n } from '#imports'
import { isWorkbenchLocale, saveWorkbenchLocale } from '../utils/workbench-locale'
import { VIEWS_LOCATION } from '../utils/workbench-routes'

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
	/** Why the Comment tool can't start (role, snapshot, phone, no live Preview…); undefined when it can. */
	commentBlockedReason: () => string | undefined
	/** Why "Comment on this View" can't start; undefined when it can. */
	viewCommentBlockedReason: () => string | undefined
	/** Opens the composer on the View as a whole (the RootShell anchor). */
	commentOnView: () => void
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
	/** The Create Checkpoint dialog (Rule 01a11a5e-0c71-78d1-9adb-14db6c67ab9c), opened from a toolbar or ⌘K. */
	const checkpointOpen = ref(false)
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
					'g-v': () => navigateTo(VIEWS_LOCATION),
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
		checkpointOpen,
		singleKeyShortcuts,
		setSingleKeyShortcuts,
		toggleWorkbenchTheme,
		switchWorkbenchLanguage,
		onToggleSidebar: (handler: () => void) => { toggleSidebarHandler = handler },
		/**
		 * Pages with a right panel register how `]` toggles it and get the unregister function. It
		 * clears only its own handler: the next page registers before the previous one unmounts.
		 */
		onToggleRightPanel: (handler: () => void) => {
			toggleRightPanelHandler = handler
			return () => {
				if (toggleRightPanelHandler === handler) toggleRightPanelHandler = undefined
			}
		},
		/** The mounted canvas registers its zoom and tool commands; the returned function unregisters them (its own only). */
		onCanvasCommands: (commands: CanvasCommands) => {
			canvasCommands.value = commands
			return () => {
				if (canvasCommands.value === commands) canvasCommands.value = undefined
			}
		},
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
