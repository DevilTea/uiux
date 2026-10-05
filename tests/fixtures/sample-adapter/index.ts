import { createWidgetPlugin } from '@deviltea/widget-core'
import { defineComponent, h } from 'vue'
import { useWidget } from '@deviltea/widget-vue'

export interface CounterInterfaces {
	state: { count: number }
}

export const counterPlugin = createWidgetPlugin('Counter')
	.description('Sample counter widget plugin for testing')
	.interfaces<CounterInterfaces>()
	.state(state => state.count({
		authorWritable: true,
		validate: (input): input is number => typeof input === 'number',
		default: () => 0,
	}))
	.done()

export const CounterRenderer = defineComponent({
	name: 'CounterRenderer',
	setup() {
		const { useState } = useWidget(counterPlugin)
		const state = useState()
		return () => h('div', { class: 'sample-counter-widget', 'data-widget-id': 'counter' }, [
			h('span', { class: 'count-value' }, `Count: ${state.count.value}`),
		])
	},
})

export const manifest = {
	id: 'sample-adapter',
	apiVersion: '1',
	widgetPlugins: [counterPlugin],
	catalog: {
		widgets: {
			Counter: {},
		},
	},
	renderers: [
		{ type: 'Counter', component: CounterRenderer },
	],
	providers: [],
	styles: [],
	tokens: [],
}
