import { describe, expect, it } from 'vitest'
import { createSettingsSection } from '../app/composables/useSettingsSection'
import { adapterRows, adapterSelections, type AdapterRow } from '../app/utils/workspace-authoring'
import type { WorkspaceAdapterSelection } from '../src/domain/workspace/schema'

type Kit = { adapters: WorkspaceAdapterSelection[] }

function adaptersSection() {
	return createSettingsSection<AdapterRow[], Kit>({
		id: 'adapters',
		fromManifest: kit => adapterRows(kit.adapters),
		toPayload: draft => adapterSelections(draft),
	})
}

const KIT: Kit = { adapters: [{ moduleSpecifier: './adapters/reference.ts', config: { note: 'kit' } }] }

describe('Settings section sync', () => {
	// Issue #228: the Product Kit page reads the file twice after a save; the second, unchanged read
	// rebuilt the rows with new keys, remounting the Config field the user had just started editing.
	it('keeps the draft rows when a read of the revision it already holds arrives', () => {
		const section = adaptersSection()
		section.sync({ revision: 'r1', resource: KIT })
		const uids = section.draft!.map(row => row.uid)
		section.sync({ revision: 'r1', resource: structuredClone(KIT) })
		expect(section.draft!.map(row => row.uid)).toEqual(uids)
		expect(section.dirty).toBe(false)
	})

	it('adopts a newer revision when there is no draft', () => {
		const section = adaptersSection()
		section.sync({ revision: 'r1', resource: KIT })
		section.sync({ revision: 'r2', resource: { adapters: [{ moduleSpecifier: './adapters/second.ts' }] } })
		expect(section.base?.revision).toBe('r2')
		expect(section.draft!.map(row => row.moduleSpecifier)).toEqual(['./adapters/second.ts'])
	})

	it('still clears a shown error on a read of the same revision with no draft', () => {
		const section = adaptersSection()
		section.sync({ revision: 'r1', resource: KIT })
		section.error = { message: 'The config write failed.' } as typeof section.error
		section.sync({ revision: 'r1', resource: KIT })
		expect(section.error).toBeUndefined()
	})
})
