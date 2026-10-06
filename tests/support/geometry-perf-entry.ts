/**
 * Browser bundle for the geometry performance harness (tests/geometry-perf.test.ts). It exposes the
 * production runtime producer, DOM measurer, invalidation signals, protocol bridges, Workbench
 * stream coordinator, pin placement and outer mapping, unchanged, on one global.
 */
import { RuntimeGeometryProducer } from '../../src/preview/geometry-producer'
import { createDomGeometryMeasurer } from '../../src/preview/dom-geometry'
import { attachGeometrySignals } from '../../src/preview/geometry-signals'
import { RuntimePreviewProtocolBridge, WorkbenchPreviewProtocolBridge } from '../../src/preview/protocol/bridge'
import { GeometryStreamCoordinator } from '../../src/preview/geometry-streams'
import { PinPlacementEngine, clusterPins, pinGeometryDemand } from '../../src/preview/pin-visibility'
import { OuterMappingObserverController } from '../../src/preview/outer-observer'
import { measureContentBoxQuad } from '../../src/preview/axis-aligned-content-quad'
import { deriveOuterMapping } from '../../src/preview/derived-outer-mapping'
import { MULTI_TARGET_GEOMETRY_FEATURE } from '../../src/preview/protocol/schema'

export const perfApi = {
	RuntimeGeometryProducer,
	createDomGeometryMeasurer,
	attachGeometrySignals,
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	GeometryStreamCoordinator,
	PinPlacementEngine,
	clusterPins,
	pinGeometryDemand,
	OuterMappingObserverController,
	measureContentBoxQuad,
	deriveOuterMapping,
	MULTI_TARGET_GEOMETRY_FEATURE,
}

export type GeometryPerfGlobal = Readonly<{ UiuxGeometryPerf: typeof perfApi }>

Object.assign(globalThis, { UiuxGeometryPerf: perfApi })
