import { computed, readonly, ref } from 'vue'

/**
 * The reviewer's display name, chosen locally in this browser. There is no roster and no
 * authentication (PRODUCT.md, Undecided): the name is only written as Review actor
 * provenance `{ type: 'human', displayName }`.
 */
export const REVIEWER_NAME_STORAGE_KEY = 'uiux.reviewer.name'
export const REVIEWER_NAME_MAX_LENGTH = 80

function readSavedName(): string {
	try {
		return globalThis.localStorage?.getItem(REVIEWER_NAME_STORAGE_KEY)?.trim() ?? ''
	}
	catch {
		return ''
	}
}

const reviewerName = ref(readSavedName())

export function reviewerInitials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean)
	if (!words.length) return ''
	// CJK names read as a whole; take the first character.
	if (words.length === 1) return /^[\p{Script=Han}]/u.test(words[0]!) ? words[0]!.slice(0, 1) : words[0]!.slice(0, 2).toUpperCase()
	return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase()
}

export function useReviewerIdentity() {
	function setName(value: string): void {
		const next = value.trim().slice(0, REVIEWER_NAME_MAX_LENGTH)
		reviewerName.value = next
		try {
			if (next) globalThis.localStorage?.setItem(REVIEWER_NAME_STORAGE_KEY, next)
			else globalThis.localStorage?.removeItem(REVIEWER_NAME_STORAGE_KEY)
		}
		catch {
			// Storage may be unavailable (private mode); the name still applies for this session.
		}
	}

	const hasName = computed(() => reviewerName.value.length > 0)
	const initials = computed(() => reviewerInitials(reviewerName.value))
	/** Review actor provenance for mutations, or undefined until a name is set. */
	const actor = computed(() => hasName.value ? { type: 'human' as const, displayName: reviewerName.value } : undefined)

	return { name: readonly(reviewerName), hasName, initials, actor, setName }
}
