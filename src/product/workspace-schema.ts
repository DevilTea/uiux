import { defineWorkspaceSchemaPolicy } from '../persistence/schema-policy'
import packageJson from '../../package.json' with { type: 'json' }

/**
 * Product-owned authority for the canonical Workspace persisted format.
 *
 * Persistence deliberately accepts an injected policy; runtime composition, init, and migration
 * entrypoints must import this module instead of inferring a version from an opened Workspace.
 */
export const CURRENT_WORKSPACE_SCHEMA_VERSION = packageJson.uiuxWorkspaceSchemaVersion

export const PRODUCT_WORKSPACE_SCHEMA_POLICY = defineWorkspaceSchemaPolicy({
	currentVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
	recognizedVersions: [CURRENT_WORKSPACE_SCHEMA_VERSION],
	steps: [],
})
