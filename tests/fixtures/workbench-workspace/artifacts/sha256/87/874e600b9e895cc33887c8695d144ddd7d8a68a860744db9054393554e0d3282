import { createWidgetPlugin, type JsonValue } from '@deviltea/widget-core'
import { defineComponent, h } from 'vue'
import { useWidget } from '@deviltea/widget-vue'

import type { TranslationResult } from '../domain/i18n/schema'
import type { TranslationRuntime } from '../i18n'

export type RootShellViewport = Readonly<{
	id: string
	width: number
	height: number
}>

export interface RootShellInterfaces {
	slots: 'content'
	state: {
		locale: string
		viewport: RootShellViewport
		themeId: string
		variantName: string | null
	}
	methods: {
		t: (key: string, params?: Readonly<Record<string, string>>) => TranslationResult
	}
}

export function createRootShellPlugin(translation: TranslationRuntime) {
	return createWidgetPlugin('RootShell')
		.description('UIUX-managed View root and read-only presentation context boundary.')
		.interfaces<RootShellInterfaces>()
		.slots({ content: { description: 'Ordered authored View content.' } })
		.state(state => state
			.locale({ validate: (input): input is string => typeof input === 'string' && input.length > 0 })
			.viewport({ validate: isRootShellViewport })
			.themeId({ validate: (input): input is string => typeof input === 'string' && input.length > 0 })
			.variantName({ validate: (input): input is string | null => input === null || (typeof input === 'string' && input.length > 0) }))
		.methods(methods => methods.t({
			registerDeps: ({ dep }) => ({ locale: dep.self.state.get('locale') }),
			validateArgs: (args): args is [string, Readonly<Record<string, string>>?] => validateTranslationArgs(args),
			execute: ({ args, deps }) => {
				const locale = deps.locale()
				if (!locale.ok || locale.value === null)
					return { text: `⟦missing:${args[0]}⟧`, warnings: [{ code: 'unresolved-key', key: args[0], requestedLocale: '' }] }
				return translation.translate(locale.value, args[0], args[1])
			},
		}))
		.done()
}

export type RootShellPlugin = ReturnType<typeof createRootShellPlugin>

export function createRootShellRenderer(plugin: RootShellPlugin) {
	return defineComponent({
		name: 'UiuxRootShellRenderer',
		setup() {
			const { WidgetSlot } = useWidget(plugin)
			return () => h(WidgetSlot, { name: 'content' })
		},
	})
}

function isRootShellViewport(input: unknown): input is RootShellViewport {
	if (!isRecord(input)) return false
	return typeof input.id === 'string' && input.id.length > 0
		&& typeof input.width === 'number' && Number.isFinite(input.width)
		&& typeof input.height === 'number' && Number.isFinite(input.height)
}

function validateTranslationArgs(args: readonly unknown[]): args is [string, Readonly<Record<string, string>>?] {
	if (args.length < 1 || args.length > 2 || typeof args[0] !== 'string') return false
	if (args.length === 1 || args[1] === undefined) return true
	if (!isRecord(args[1])) return false
	return Object.values(args[1]).every(value => typeof value === 'string')
}

function isRecord(value: unknown): value is Record<string, JsonValue | undefined> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
