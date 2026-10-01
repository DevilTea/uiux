import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError, ResourceTemplate, createMcpHandler, type McpHttpHandler, type ReadResourceResult } from '@modelcontextprotocol/server'
import packageJson from '../../package.json' with { type: 'json' }
import { z } from 'zod'

import { DISCOVERABLE_RESOURCE_KINDS, MAX_RESOURCE_DISCOVERY_LIMIT } from '../application/dto/resource-discovery'
import type { PointResourceKind } from '../application/dto/point-resources'
import type { WorkspaceApplicationSession } from '../application/services/workspace-session'
import { parsePointResourceUri, pointResourceUri } from './resource-uri'

const dynamicKinds = ['view', 'flow', 'locale'] as const satisfies readonly PointResourceKind[]
const discoveryKindsSchema = z.array(z.enum(DISCOVERABLE_RESOURCE_KINDS)).optional()
const discoveryBaseShape = {
	kinds: discoveryKindsSchema,
	cursor: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(MAX_RESOURCE_DISCOVERY_LIMIT),
}
const listResourcesSchema = z.object(discoveryBaseShape).strict()
const searchResourcesSchema = z.object({ ...discoveryBaseShape, query: z.string().min(1) }).strict()

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
	server.registerTool(
		'list_resources',
		{
			title: 'List UIUX resources',
			description: 'List compact canonical resource summaries with stable point-resource URIs.',
			inputSchema: listResourcesSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => discoveryToolResult(app, 'list', input),
	)
	server.registerTool(
		'search_resources',
		{
			title: 'Search UIUX resources',
			description: 'Search compact canonical resource summaries without returning full resource bodies.',
			inputSchema: searchResourcesSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => discoveryToolResult(app, 'search', input),
	)
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

async function discoveryToolResult(app: WorkspaceApplicationSession, mode: 'list' | 'search', input: unknown) {
	const outcome = mode === 'list' ? await app.listPointResources(input) : await app.searchPointResources(input)
	if (outcome.status === 'invalid')
		throw new ProtocolError(ProtocolErrorCode.InvalidParams, outcome.diagnostics.map(item => `${item.path || '/'}: ${item.message}`).join('; '))
	const output = {
		items: outcome.page.items.map(item => ({ ...item, resourceUri: pointResourceUri({ kind: item.kind, key: item.key }) })),
		...(outcome.page.nextCursor ? { nextCursor: outcome.page.nextCursor } : {}),
	}
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(output) }],
		structuredContent: output,
	}
}
