import { defineAppConfig } from '#imports'

/**
 * Nuxt UI 4 theme for the Workbench chrome ("The Quiet Canvas", DESIGN.md).
 *
 * Colors map Nuxt UI roles onto the custom ramps declared in `assets/css/main.css`:
 * Iris (selection, focus, the one primary action), Marker (human annotation),
 * Leaf (success only) and Graphite (all chrome). Per-mode shades are picked by
 * the `--ui-*` overrides in that stylesheet. None of this reaches the Preview
 * iframe's render context, which uses the Workspace's own themes.
 */
export default defineAppConfig({
	ui: {
		colors: {
			primary: 'iris',
			secondary: 'graphite',
			annotation: 'marker',
			success: 'leaf',
			info: 'blue',
			warning: 'yellow',
			error: 'red',
			neutral: 'graphite',
		},
		button: {
			// Violet must be asked for: the default button is neutral outline.
			defaultVariants: { color: 'neutral', variant: 'outline', size: 'md' },
			slots: { base: 'min-h-(--wb-target) font-medium' },
			compoundVariants: [
				// The No-Opacity-Hover Rule: filled controls move one ramp step instead of fading.
				{ color: 'primary', variant: 'solid', class: 'hover:bg-primary-700 active:bg-primary-800 dark:hover:bg-primary-300 dark:active:bg-primary-200' },
				{ color: 'annotation', variant: 'solid', class: 'hover:bg-annotation-800 active:bg-annotation-900 dark:hover:bg-annotation-300 dark:active:bg-annotation-200' },
				{ color: 'success', variant: 'solid', class: 'hover:bg-success-800 dark:hover:bg-success-300' },
				{ color: 'error', variant: 'solid', class: 'hover:bg-error-800 dark:hover:bg-error-300' },
				{ color: 'neutral', variant: 'solid', class: 'hover:bg-neutral-700 dark:hover:bg-neutral-200' },
				// A visible 2px Iris focus outline on every variant (the stock 25% outline fails 3:1).
				{
					color: ['primary', 'secondary', 'annotation', 'success', 'info', 'warning', 'error', 'neutral'],
					variant: ['solid', 'outline', 'soft', 'subtle', 'ghost', 'link'],
					class: 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
				},
			],
		},
		badge: {
			defaultVariants: { variant: 'subtle', size: 'md' },
			variants: {
				size: {
					// The 12px Floor Rule: the stock xs/sm sizes render at 8px and 10px.
					xs: { base: 'text-xs/4 px-1 py-0 gap-1 rounded-sm' },
					sm: { base: 'text-xs/4 px-1.5 py-0.5 gap-1 rounded-sm' },
					md: { base: 'text-xs/4 px-1.5 py-0.5 gap-1 rounded-sm' },
				},
			},
		},
		kbd: {
			defaultVariants: { size: 'md' },
			variants: {
				size: {
					sm: 'h-5 min-w-5 text-xs',
					md: 'h-5 min-w-5 text-xs',
				},
			},
		},
		avatar: {
			variants: {
				size: {
					'3xs': { root: 'size-5 text-xs' },
					'2xs': { root: 'size-5 text-xs' },
				},
			},
		},
		// Group labels in menus and lists: 12px floor instead of the stock 10px.
		select: { variants: { size: { xs: { label: 'text-xs/4' }, sm: { label: 'text-xs/4' } } } },
		selectMenu: { variants: { size: { xs: { label: 'text-xs/4' }, sm: { label: 'text-xs/4' } } } },
		inputMenu: { variants: { size: { xs: { label: 'text-xs/4', tagsItem: 'text-xs/4' }, sm: { label: 'text-xs/4', tagsItem: 'text-xs/4' } } } },
		listbox: { variants: { size: { xs: { label: 'text-xs/4' }, sm: { label: 'text-xs/4' } } } },
		commandPalette: { variants: { size: { xs: { label: 'text-xs/4' }, sm: { label: 'text-xs/4' } } } },
		input: { slots: { base: 'pointer-coarse:text-base' } },
		textarea: { slots: { base: 'pointer-coarse:text-base' } },
		tabs: { slots: { trigger: 'min-h-(--wb-target)' } },
		tree: { slots: { link: 'min-h-7 pointer-coarse:min-h-11', linkLabel: 'truncate' } },
		popover: { slots: { content: 'shadow-overlay ring-0 rounded-lg' } },
		dropdownMenu: { slots: { content: 'shadow-overlay ring-0 rounded-lg' } },
		tooltip: { slots: { content: 'text-xs/4 h-auto py-1 shadow-overlay ring-0' } },
		navigationMenu: {
			slots: { link: 'min-h-(--wb-target)', linkLeadingIcon: 'size-4' },
			compoundVariants: [
				// Active area: elevated fill, highlighted text and a 2px Iris bar on the leading edge.
				{ color: 'neutral', variant: 'pill', active: true, orientation: 'vertical', class: { link: 'before:bg-elevated text-highlighted after:absolute after:inset-y-1.5 after:start-0 after:w-0.5 after:rounded-full after:bg-primary' } },
				{ color: 'neutral', variant: 'pill', active: false, class: { link: 'hover:before:bg-muted' } },
			],
		},
		// The Workbench shell sits below a fixed header, so dashboard panes fill
		// their flex parent instead of the full viewport height.
		dashboardGroup: {
			base: 'relative flex min-h-0 flex-1 overflow-hidden',
		},
		dashboardSidebar: {
			slots: {
				// Inline from the tablet breakpoint; a slide-over menu below it (brief a).
				root: 'min-h-0 h-auto bg-default',
				header: 'h-auto px-0',
				body: 'gap-0 p-0 overflow-hidden',
			},
		},
		dashboardPanel: {
			slots: {
				root: 'min-h-0 h-full',
				body: 'gap-0 p-0 sm:p-0',
			},
		},
	},
})
