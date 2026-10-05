/** Avatar initials for a roster nickname (or any display name written on older records). */
export function memberInitials(name: string): string {
	const words = name.trim().split(/[\s._-]+/).filter(Boolean)
	if (!words.length) return ''
	// CJK names read as a whole; take the first character.
	if (words.length === 1) return /^[\p{Script=Han}]/u.test(words[0]!) ? words[0]!.slice(0, 1) : words[0]!.slice(0, 2).toUpperCase()
	return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase()
}
