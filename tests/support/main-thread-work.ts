/**
 * Test-only instrumentation, injected with `addInitScript` into the Workbench and its Preview
 * iframe, that measures main-thread work without a tracing session (tracing itself costs several
 * milliseconds per frame on a throttled CPU and would distort the budget numbers).
 *
 * Every requestAnimationFrame callback and every `message` listener on `window` is timed from its
 * start until the end of the microtasks it queued (Vue's scheduler flush included): a microtask
 * queued after the callback returns runs after them. Entries are absolute times
 * (`timeOrigin + now`), so the two documents share one clock. The harness's own frame loops use
 * `__rawRequestAnimationFrame` and are not counted.
 */

export type WorkEntry = readonly [start: number, duration: number, kind: 'frame' | 'message']

export type MainThreadWorkWindow = Window & {
	__work: WorkEntry[]
	__rawRequestAnimationFrame: (callback: FrameRequestCallback) => number
}

export const MAIN_THREAD_WORK = `(() => {
	const clock = () => performance.timeOrigin + performance.now()
	const raw = window.requestAnimationFrame.bind(window)
	window.__work = []
	window.__rawRequestAnimationFrame = raw
	window.requestAnimationFrame = (callback) => raw((time) => {
		const start = clock()
		try { callback(time) }
		finally { queueMicrotask(() => { window.__work.push([start, clock() - start, 'frame']) }) }
	})
	const add = EventTarget.prototype.addEventListener
	const remove = EventTarget.prototype.removeEventListener
	const wrapped = new WeakMap()
	EventTarget.prototype.addEventListener = function (type, listener, options) {
		if (type !== 'message' || this !== window || typeof listener !== 'function') return add.call(this, type, listener, options)
		let timed = wrapped.get(listener)
		if (!timed) {
			timed = function (event) {
				const start = clock()
				try { return listener.call(this, event) }
				finally { queueMicrotask(() => { window.__work.push([start, clock() - start, 'message']) }) }
			}
			wrapped.set(listener, timed)
		}
		return add.call(this, type, timed, options)
	}
	EventTarget.prototype.removeEventListener = function (type, listener, options) {
		return remove.call(this, type, (type === 'message' && wrapped.get(listener)) || listener, options)
	}
})()`

export type FrameBudget = Readonly<{
	/** Frame intervals of the Workbench document, ms. */
	intervals: readonly number[]
	/** Per frame: Workbench animation-frame work (placement, containment, clustering, transform writes, list updates). */
	pinWork: readonly number[]
	/** Per frame: Workbench report receipt (deserialization, validation, stream gates). */
	messages: readonly number[]
	/** Per frame: Preview runtime work (geometry producer and its sends). */
	runtime: readonly number[]
	/** Per frame: everything above. */
	combined: readonly number[]
}>

/** Bins Workbench and runtime work entries into the Workbench frames given by `marks` (absolute ms). */
export function binFrames(marks: readonly number[], workbench: readonly WorkEntry[], runtime: readonly WorkEntry[]): FrameBudget {
	const intervals: number[] = []
	const pinWork: number[] = []
	const messages: number[] = []
	const runtimeWork: number[] = []
	const combined: number[] = []
	for (let index = 1; index < marks.length; index++) {
		const start = marks[index - 1]!
		const end = marks[index]!
		const inFrame = (entry: WorkEntry) => entry[0] >= start && entry[0] < end
		const sum = (entries: readonly WorkEntry[], kind?: WorkEntry[2]) => entries.filter(entry => inFrame(entry) && (!kind || entry[2] === kind)).reduce((total, entry) => total + entry[1], 0)
		const frame = sum(workbench, 'frame')
		const message = sum(workbench, 'message')
		const produced = sum(runtime)
		intervals.push(end - start)
		pinWork.push(frame)
		messages.push(message)
		runtimeWork.push(produced)
		combined.push(frame + message + produced)
	}
	return { intervals, pinWork, messages, runtime: runtimeWork, combined }
}

export function percentile(values: readonly number[], p: number): number {
	if (!values.length) return Number.NaN
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!
}
