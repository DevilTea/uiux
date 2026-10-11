import { checkWorkspaceSelection, type WorkspaceSelection } from '../persistence/workspace-selection'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'

/** The entry check of an explicitly selected Workspace under UIUX's own schema policy (`uiux dev`). */
export function checkSelectedWorkspace(root: string): WorkspaceSelection {
	return checkWorkspaceSelection(root, PRODUCT_WORKSPACE_SCHEMA_POLICY)
}
