import { AsyncLocalStorage } from 'node:async_hooks'

import { HISTORY_SOURCES, HISTORY_WRITE_OPERATIONS, type HistorySource, type HistoryWriteOperation } from '../../domain/history/constants'
import { validateHistoryActor, type HistoryActor } from '../../domain/history/schema'
import { isFullUuid } from '../../domain/validation'

/**
 * The design-write context (recorder seam 6 of the version timeline): who performs the current
 * design operation, through which source, and which operation it is. The application layer sets
 * it around one design write; persistence reads it to decide whether to call its history
 * observer. Without a context no observer hook is ever called, so in-process writes (tests, the
 * CLI, migration) stay invisible to history unless their caller opts in.
 *
 * `restoredFrom` names the version a `restoreResourceVersion` copied (Clause
 * 01a11a5e-20c6-7573-8530-e6fed6d8d4af).
 */
export type DesignWriteContext = Readonly<{
	actor: HistoryActor
	source: HistorySource
	operation: HistoryWriteOperation
	restoredFrom?: string
}>

const storage = new AsyncLocalStorage<DesignWriteContext>()

/** Runs `operation` with `context` as the current design-write context; nesting replaces it. */
export function runWithDesignWriteContext<Result>(context: DesignWriteContext, operation: () => Result): Result {
	assertDesignWriteContext(context)
	return storage.run(Object.freeze({ ...context }), operation)
}

/** The design-write context of the running asynchronous call chain, if any. */
export function currentDesignWriteContext(): DesignWriteContext | undefined {
	return storage.getStore()
}

function assertDesignWriteContext(context: DesignWriteContext): void {
	const actor = validateHistoryActor(context?.actor)
	if (!actor.ok)
		throw new TypeError(`A design-write context needs a stamped history actor: ${actor.diagnostics.map(item => item.message).join(' ')}`)
	if (!(HISTORY_SOURCES as readonly string[]).includes(context.source))
		throw new TypeError(`A design-write context source must be ${HISTORY_SOURCES.join(', ')}.`)
	if (!(HISTORY_WRITE_OPERATIONS as readonly string[]).includes(context.operation))
		throw new TypeError('A design-write context operation must be one of the recorded design operations.')
	if (context.restoredFrom !== undefined && !isFullUuid(context.restoredFrom))
		throw new TypeError('A design-write context restoredFrom must be a full UUID version id.')
}
