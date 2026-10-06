/**
 * Why a new comment cannot be started right now (review feedback 8dd59d25). The Comment tool,
 * "Comment on this View", the `C` key and the command palette never silently do nothing: each
 * blocked state has a code, and the Workbench shows its reason (`commentBlock.<code>`) in the
 * disabled control's tooltip and, when the control is used anyway, in a toast.
 *
 * Replies, resolve and reopen have their own rules; this is only about creating a thread.
 */
export type CommentBlockCode =
	| 'publication'
	| 'migration'
	| 'unsupported'
	| 'signed-out'
	| 'role'
	| 'handset'
	| 'no-view'
	| 'connecting'
	| 'reconnecting'
	| 'stopped'

export type CommentAvailabilityInput = Readonly<{
	/** A read-only `uiux publish` snapshot. */
	publication: boolean
	/** `workspace.inspection.state`: the server refuses every write until `uiux migrate`. */
	workspaceState?: string
	/** A member is signed in to this Workbench. */
	signedIn: boolean
	/** The member's role is Reviewer or above. */
	canReview: boolean
	/** Phone width, or a short touch screen: handsets read, reply and triage only. */
	handset: boolean
	/** A View is open. */
	hasView: boolean
	/** The Preview session (`SessionStatusKind`). */
	session: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stopped'
}>

/**
 * Whether a thread can be created at all, in the order a person can fix it: the snapshot, the
 * Workspace, the sign-in, the role, then the device. "Comment on this View" needs nothing more:
 * it targets the RootShell and never waits for the Preview to hit-test a Widget.
 */
export function commentCreateBlock(input: CommentAvailabilityInput): CommentBlockCode | undefined {
	if (input.publication) return 'publication'
	if (input.workspaceState === 'migration_required') return 'migration'
	if (input.workspaceState === 'unsupported') return 'unsupported'
	if (!input.signedIn) return 'signed-out'
	if (!input.canReview) return 'role'
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
