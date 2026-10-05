<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { splitWidgetMentions } from '../../utils/widget-inspection'

/** Authored Spec prose where `#widget-id` mentions of this View's Widgets select them on the canvas. */
const props = defineProps<{ text: string; widgetIds: ReadonlySet<string> }>()
const emit = defineEmits<{ (e: 'select', widgetId: string): void }>()
const { t } = useI18n()

const segments = computed(() => splitWidgetMentions(props.text, props.widgetIds))
</script>

<template>
  <template
    v-for="(segment, index) in segments"
    :key="index"
  >
    <ULink
      v-if="segment.kind === 'widget'"
      as="button"
      type="button"
      class="rounded-sm font-mono text-sm text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      translate="no"
      :aria-label="t('inspect.selectWidget', { id: segment.widgetId })"
      @click="emit('select', segment.widgetId)"
    >
      {{ segment.text }}
    </ULink>
    <template v-else>
      {{ segment.text }}
    </template>
  </template>
</template>
