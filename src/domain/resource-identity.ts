/** The identity of a canonical resource as a map key: its kind and key, which never contain a NUL. */
export function resourceIdentityKey(resource: Readonly<{ kind: string; key: string }>): string {
	return `${resource.kind}\0${resource.key}`
}
