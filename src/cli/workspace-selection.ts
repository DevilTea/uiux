import { selectWorkspace, type SelectedWorkspace } from '../persistence/workspace-selection'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../product/workspace-schema'

/**
 * The Workspace `uiux dev` acts on: `--workspace <dir>` when given, otherwise the
 * discovered one, after the entry check, under UIUX's own schema policy (`selectWorkspace`).
 */
export function selectCliWorkspace(workspace: string | undefined, cwd: string): SelectedWorkspace {
	return selectWorkspace({ ...(workspace === undefined ? {} : { workspace }), cwd }, PRODUCT_WORKSPACE_SCHEMA_POLICY)
}
