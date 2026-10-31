import { computed, type ComputedRef } from 'vue'
import { useKbd } from '#imports'
import { useMediaQuery } from './useMediaQuery'

/**
 * Keyboard hint text for a Kit Button's `kbd` prop (the Kit takes the shortcut as literal text, where
 * Nuxt UI's `UKbd` resolved key names such as `meta` itself). Both are `undefined` on a touch
 * screen, which has no keyboard to hint at (brief c, section 9).
 */
export function useKbdHints(): Readonly<{ submit: ComputedRef<string | undefined>; cancel: ComputedRef<string | undefined> }> {
	const { getKbdKey, macOS } = useKbd()
	const coarse = useMediaQuery('(pointer: coarse)')
	return {
		/** The "send / save" chord: `⌘↵` on macOS, `Ctrl ↵` elsewhere. */
		submit: computed(() => coarse.value ? undefined : [getKbdKey('meta'), getKbdKey('enter')].join(macOS.value ? '' : ' ')),
		cancel: computed(() => coarse.value ? undefined : getKbdKey('escape')),
	}
}
