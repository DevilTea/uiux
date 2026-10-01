import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError, ResourceTemplate, createMcpHandler, type McpHttpHandler, type ReadResourceResult } from '@modelcontextprotocol/server'
import packageJson from '../../package.json' with { type: 'json' }

import type { PointResourceKind } from '../application/dto/point-resources'
import type { WorkspaceApplicationSession } from '../application/services/workspace-session'
import { parsePointResourceUri, pointResourceUri } from './resource-uri'

const dynamicKinds = ['view', 'flow', 'locale'] as const satisfies readonly PointResourceKind[]

export function createUiuxMcpServer(app: WorkspaceApplicationSession): McpServer {
	const server = new McpServer({ name: '@deviltea/uiux', version: packageJson.version })
	server.registerResource(
		'workspace',
		pointResourceUri({ kind: 'workspace', key: 'workspace' }),
		{ title: 'Selected UIUX Workspace', mimeType: 'application/json' },
		async uri => resourceResult(app, uri),
	)
	for (const kind of dynamicKinds) {
		server.registerResource(
			kind,
			new ResourceTemplate(`uiux://${kind}/{key}`, { list: undefined }),
			{ title: `UIUX ${kind} point resource`, mimeType: 'application/json' },
			async uri => resourceResult(app, uri),
		)
	}
	return server
}

export function createUiuxMcpHttpHandler(app: WorkspaceApplicationSession): McpHttpHandler {
	return createMcpHandler(() => createUiuxMcpServer(app))
}

async function resourceResult(app: WorkspaceApplicationSession, uri: URL): Promise<ReadResourceResult> {
	const address = parsePointResourceUri(uri)
	if (!address) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unsupported UIUX resource URI: ${uri.href}`)
	const read = await app.readPointResource(address.kind, address.key)
	if (!read) throw new ResourceNotFoundError(uri.href, `UIUX resource not found: ${uri.href}`)
	return {
		contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(read) }],
	}
}
