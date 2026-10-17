/**
 * Why a new comment cannot be started right now (review feedback 8dd59d25). The Comment tool,
 * "Comment on this View", the `C` key and the command palette never silently do nothing: each
 * blocked state has a code, and the Workbench shows its reason (`commentBlock.<code>`) in the
 * disabled control's tooltip and, when the control is used anyway, in a toast.
 *
 * Replies, resolve and reopen have their own rules; this is only about creating a thread.
 */
export type CommentBlockCode =
	| 'unsupported'
	| 'signed-out'
	| 'key'
	| 'handset'
	| 'no-view'
	| 'connecting'
	| 'reconnecting'
	| 'stopped'

export type CommentAvailabilityInput = Readonly<{
	/** `workspace.inspection.state`: the server refuses every write while it is `unsupported`. */
	workspaceState?: string
	/** A member is signed in to this Workbench. */
	signedIn: boolean
	/** The member holds `reviews.write`, which creating a thread needs. */
	canWriteReviews: boolean
	/** Phone width, or a short touch screen: handsets read, reply and triage only. */
	handset: boolean
	/** A View is open. */
	hasView: boolean
	/** The Preview session (`SessionStatusKind`). */
	session: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stopped'
}>

/**
 * Whether a thread can be created at all, in the order a person can fix it: the Workspace, the
 * sign-in, the `reviews.write` key, then the device. "Comment on this View" needs nothing more:
 * it targets the RootShell and never waits for the Preview to hit-test a Widget.
 */
export function commentCreateBlock(input: CommentAvailabilityInput): CommentBlockCode | undefined {
	if (input.workspaceState === 'unsupported') return 'unsupported'
	if (!input.signedIn) return 'signed-out'
	if (!input.canWriteReviews) return 'key'
	if (input.handset) return 'handset'
	if (!input.hasView) return 'no-view'
	return undefined
}

/** The canvas Comment tool also needs a live Preview: the iframe does the hit-testing. */
export function commentToolBlock(input: CommentAvailabilityInput): CommentBlockCode | undefined {
	const block = commentCreateBlock(input)
	if (block) return block
	switch (input.session) {
		case 'live': return undefined
		case 'reconnecting': return 'reconnecting'
		case 'stopped': return 'stopped'
		default: return 'connecting'
	}
}

/** Why a thread cannot be resolved: the Workspace, an Agent, or the missing `reviews.resolve`. */
export type ResolveBlockCode = 'unsupported' | 'agent' | 'key'

/**
 * Why the member cannot resolve, in the same order as `commentCreateBlock`: a write-blocked
 * Workspace first, so a holder of `reviews.resolve` is told about the Workspace rather than a key
 * it holds; then an Agent, which never can (Rule 01a11c09-bec8-7dee-971a-4c10eaf83eef); then the
 * missing key. `undefined` when nothing blocks it.
 */
export function resolveBlock(input: Readonly<{ workspaceState?: string; agent: boolean; holdsResolve: boolean }>): ResolveBlockCode | undefined {
	if (input.workspaceState === 'unsupported') return 'unsupported'
	if (input.agent) return 'agent'
	if (!input.holdsResolve) return 'key'
	return undefined
}

/** The message for a `ResolveBlockCode`, in the Workbench's words. */
export function resolveBlockMessage(code: ResolveBlockCode, t: (key: string, params?: Record<string, unknown>) => string): string {
	if (code === 'agent') return t('comments.resolveNeedsPerson')
	if (code === 'key') return t('access.requiresKey', { key: 'reviews.resolve' })
	return t(`commentBlock.${code}`)
}
