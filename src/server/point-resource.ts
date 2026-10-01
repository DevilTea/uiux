import { isPointResourceKind, isValidPointResourceAddress, type PointResourceKind } from '../application/dto/point-resources'
import type { PointResourceRead, WorkspaceApplicationSession } from '../application/services/workspace-session'

export type PointResourceHttpResult =
	| Readonly<{ status: 200; body: PointResourceRead }>
	| Readonly<{ status: 400; body: { code: 'invalid_resource_address'; message: string } }>
	| Readonly<{ status: 404; body: { code: 'resource_not_found'; kind: PointResourceKind; key: string } }>

export async function readPointResourceForHttp(
	app: WorkspaceApplicationSession,
	kind: string,
	key: string,
): Promise<PointResourceHttpResult> {
	if (!isPointResourceKind(kind) || !isValidPointResourceAddress({ kind, key }))
		return { status: 400, body: { code: 'invalid_resource_address', message: 'Expected a supported point resource kind with a canonical identity key.' } }
	const read = await app.readPointResource(kind, key)
	return read
		? { status: 200, body: read }
		: { status: 404, body: { code: 'resource_not_found', kind, key } }
}
