import { isCanonicalLocaleTag, isFullUuid } from '../../domain/validation'

export type PointResourceKind = 'workspace' | 'view' | 'flow' | 'locale'
export type PointResourceAddress = Readonly<{ kind: PointResourceKind; key: string }>

export function isPointResourceKind(value: string): value is PointResourceKind {
	return value === 'workspace' || value === 'view' || value === 'flow' || value === 'locale'
}

export function isValidPointResourceAddress(address: PointResourceAddress): boolean {
	switch (address.kind) {
		case 'workspace': return address.key === 'workspace'
		case 'view':
		case 'flow': return isFullUuid(address.key)
		case 'locale': return isCanonicalLocaleTag(address.key)
	}
}
