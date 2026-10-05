import { defineAppConfig } from '#imports'

export default defineAppConfig({
	ui: {
		colors: {
			primary: 'green',
			neutral: 'neutral',
		},
		// The Workbench shell sits below a fixed header, so dashboard panes fill
		// their flex parent instead of the full viewport height.
		dashboardGroup: {
			base: 'relative flex min-h-0 flex-1 overflow-hidden',
		},
		dashboardSidebar: {
			slots: {
				root: 'min-h-0 h-full bg-default',
				header: 'h-auto px-0',
				body: 'gap-0 p-0',
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
