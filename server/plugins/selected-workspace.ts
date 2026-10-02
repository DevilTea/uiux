import {
	closeSelectedWorkspaceServerRuntime,
	getSelectedWorkspaceServerRuntime,
} from '../../src/server/selected-workspace'

export default defineNitroPlugin((nitroApp) => {
	if (process.env.UIUX_WORKSPACE_ROOT)
		getSelectedWorkspaceServerRuntime()
	nitroApp.hooks.hook('close', closeSelectedWorkspaceServerRuntime)
})
