import { V5_LAYOUT } from '../persistence/paths'
import { defineWorkspaceSchemaPolicy } from '../persistence/schema-policy'
import packageJson from '../../package.json' with { type: 'json' }

/**
 * Product-owned authority for the canonical Workspace persisted format.
 *
 * Persistence deliberately accepts an injected policy; runtime composition and init entrypoints
 * must import this module instead of inferring a version from an opened Workspace.
 */
export const CURRENT_WORKSPACE_SCHEMA_VERSION = packageJson.uiuxWorkspaceSchemaVersion

/**
 * The `.gitignore` rules for a Workspace root (Clause 01a1144e-55a3-74c4-8bf8-3205e968e275): the
 * runtime files (with the temporary files written next to the server hold and the persistence
 * lock), `kit/node_modules/` and `kit/dist/`. `uiux init` writes them.
 */
export const WORKSPACE_GITIGNORE_RULES: readonly string[] = Object.freeze([
	V5_LAYOUT.serverHoldPath,
	V5_LAYOUT.metadataFilePath('.server-hold-*.tmp'),
	V5_LAYOUT.lockPath,
	V5_LAYOUT.metadataFilePath('.persistence-lock-*'),
	`${V5_LAYOUT.transactionsDir}/`,
	`${V5_LAYOUT.codeDir}/node_modules/`,
	`${V5_LAYOUT.codeDir}/dist/`,
])

/**
 * UIUX has no Workspace migration (Rule 01a1144e-5079-7c4e-99a4-912094aba0d4): the policy
 * recognizes only the current `schemaVersion` and has no steps, so a Workspace at any other
 * version is unsupported.
 */
export const PRODUCT_WORKSPACE_SCHEMA_POLICY = defineWorkspaceSchemaPolicy({
	currentVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
})
