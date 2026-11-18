/** A canonical resource as the changes view names it: its kind and key. */
export type ChangedResourceRef = Readonly<{ kind: string; key: string }>

/** The kinds whose only key is the kind itself. */
const SINGLETON_KINDS = ['workspace', 'product-kit', 'access-presets'] as const

/**
 * A singleton resource (Workspace settings, Product Kit, Access presets) has no name of its own: its
 * key is its kind, so the kind label names it. `undefined` for any other kind.
 */
export function singletonResourceName(resource: ChangedResourceRef, kindLabel: (kind: string) => string): string | undefined {
	return (SINGLETON_KINDS as readonly string[]).includes(resource.kind) ? kindLabel(resource.kind) : undefined
}

export function sameResource(left: ChangedResourceRef | undefined, right: ChangedResourceRef | undefined): boolean {
	return left !== undefined && right !== undefined && left.kind === right.kind && left.key === right.key
}
