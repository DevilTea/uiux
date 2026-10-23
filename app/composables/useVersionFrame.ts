import { onBeforeUnmount, onMounted, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { isCapabilityDeclaration, WorkbenchPreviewProtocolBridge } from '../../src/preview/protocol/bridge'
import { GeometryStreamCoordinator, type GeometryReport } from '../../src/preview/geometry-streams'
import { MULTI_TARGET_GEOMETRY_FEATURE } from '../../src/preview/protocol/schema'
import { createPreviewWirePost, readPreviewWirePost } from '../../src/preview/protocol/transport'

let frameSequence = 0

/**
 * The Workbench side of one canvas comparison frame (issue #132, B9). The View page's own Preview
 * session (`createPreviewSession`) is one instance bound to the Workbench state, its selection,
 * targeting and pins; a comparison runs two Preview documents at once, so each frame gets this
 * smaller session of its own instead: its own `previewSessionId` and generation, a protocol bridge
 * that only answers its own iframe's window, and a geometry coordinator that streams only the
 * outlined Widgets (the existing geometry protocol, `highlight` tier). It never enters a targeting
 * interaction and never arms Widget Events: a comparison frame is read-only.
 *
 * One instance serves one iframe document: a new render context is a new document, so the caller
 * mounts a new frame (and with it a new session) rather than reusing this one.
 */
export function useVersionFrame(options: Readonly<{
	viewId: string
	variantId?: string
	/** The Widgets to outline; each gets a geometry stream while the frame is live. */
	widgets: MaybeRefOrGetter<readonly string[]>
}>) {
	const sequence = ++frameSequence
	const previewSessionId = `version-frame-${sequence}-${Date.now()}`
	/** The admitted generation: the frame's runtime names it in its declaration (issue #102). */
	const runtimeGenerationId = ref<string>()
	const iframe = ref<HTMLIFrameElement>()
	const phase = ref<'initiating' | 'open' | 'failed'>('initiating')
	/** Bumps when a report arrives or goes, so computed consumers re-read `report`. */
	const geometryVersion = ref(0)
	const overCap = shallowRef<readonly string[]>([])

	const bridge = new WorkbenchPreviewProtocolBridge(
		previewSessionId,
		{
			send(message) {
				iframe.value?.contentWindow?.postMessage(createPreviewWirePost([message]), window.location.origin)
			},
		},
		declaration => declaration.protocolVersion === 1 ? { ok: true } : { ok: false, reason: 'capability.unsupported_protocol_version' },
		{
			// The first document's generation, or a new one after the frame's document reloaded: every
			// stream of the previous generation is void until the new one's ACK.
			onGenerationAdmitted(generationId) {
				runtimeGenerationId.value = generationId
				phase.value = 'initiating'
				geometry.setContext({ previewSessionId, runtimeGenerationId: generationId, viewId: options.viewId, ...(options.variantId ? { variantId: options.variantId } : {}) })
			},
		},
	)
	const geometry = new GeometryStreamCoordinator({
		send: message => { bridge.sendGeometry(message) },
		requestFrame: callback => requestAnimationFrame(callback),
		cancelFrame: handle => cancelAnimationFrame(handle),
	})
	let frame: number | undefined
	geometry.subscribe(() => {
		frame ??= requestAnimationFrame(() => {
			frame = undefined
			overCap.value = geometry.overCapWidgets()
			geometryVersion.value++
		})
	})

	function syncDemand(): void {
		geometry.setDemand(toValue(options.widgets).map(widgetId => ({ consumerId: `highlight:${widgetId}`, widgetId, tier: 'highlight' as const })))
		overCap.value = geometry.overCapWidgets()
	}
	watch(() => toValue(options.widgets).join('\n'), syncDemand, { immediate: true })

	/**
	 * Whether the committed document is the one this frame requested (owner ruling 1 of 2026-10-23,
	 * Discussion #241): the frame's window outlives a navigation, so only the committed URL tells
	 * the requested document from the one before it.
	 */
	function requestedDocumentIsCommitted(): boolean {
		try {
			const element = iframe.value
			const location = element?.contentWindow?.location.href
			return !!element && !!location && !!element.src && location === element.src
		}
		catch {
			return false
		}
	}

	function receive(input: unknown): void {
		if (isCapabilityDeclaration(input) && !requestedDocumentIsCommitted()) return
		const result = bridge.receive(input)
		if (result.status === 'ack-dispatched') {
			const features = (input as { payload?: { features?: unknown } }).payload?.features
			phase.value = 'open'
			geometry.setMultiTarget(Array.isArray(features) && features.includes(MULTI_TARGET_GEOMETRY_FEATURE))
			geometry.setReady(true)
			syncDemand()
		}
		else if (result.status === 'accepted' && result.message.type === 'geometry.acquire.response') geometry.accept(result.message)
		else if (result.status === 'capability-failure' || result.status === 'generation-refused') phase.value = 'failed'
		else if (result.status === 'invalid' && phase.value !== 'open') phase.value = 'failed'
	}

	function onMessage(event: MessageEvent): void {
		// Only this frame's own Preview document, of this origin, is its protocol peer.
		const source = iframe.value?.contentWindow
		if (event.origin !== window.location.origin || !source || event.source !== source) return
		for (const message of readPreviewWirePost(event.data) ?? []) receive(message)
	}

	onMounted(() => window.addEventListener('message', onMessage))
	onBeforeUnmount(() => {
		window.removeEventListener('message', onMessage)
		if (frame !== undefined) cancelAnimationFrame(frame)
		geometry.dispose()
	})

	/** The latest accepted geometry of an outlined Widget, in the frame's content-viewport px. */
	function report(widgetId: string): GeometryReport | undefined {
		void geometryVersion.value
		return geometry.report(widgetId)
	}

	return { iframe, previewSessionId, runtimeGenerationId, phase, report, overCap, geometryVersion }
}
