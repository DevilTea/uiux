import { BASE_STATE_FEATURE } from './protocol/base-state'
import { CHECKS_REPORTS_FEATURE } from './protocol/checks-report'
import { FAILURE_REPORTS_FEATURE } from './protocol/failure-report'
import { MULTI_TARGET_GEOMETRY_FEATURE, REGION_STATUS_GEOMETRY_FEATURE, REVEAL_GEOMETRY_FEATURE } from './protocol/schema'
import { WIDGET_EVENTS_FEATURE } from './protocol/widget-events'

/**
 * The capability features a runtime generation declares. `widget.events`, `failure.reports` and
 * `checks.reports` belong to a Workbench Preview (decision 10; issues #312 and #347): a formal
 * capture has no Workbench parent to arm it or to read a report, and a version frame is read-only
 * with no recovery of its own and never feeds Checks. `geometry.reveal` (issue #105) belongs there
 * too: only a Checks navigation of the Workbench's own Preview asks for it, and a version frame or
 * capture is never scrolled by one. So does `geometry.region-status` (issue #106): only the
 * Workbench's highlight and Checks read what a report says about translucent coverage and
 * unavailable precision. So does `inspection.base-state` (issue #52; Clause
 * 01a19a9b-308e-7377-ac04-54b81a96e5ed): only the Workbench's Widget Inspector asks for the
 * base-state values of a Widget, and a capture or a version frame has no Inspector.
 */
export function declaredRuntimeFeatures(mode: Readonly<{ harness: boolean; version: boolean }>): string[] {
	const features = ['geometry', MULTI_TARGET_GEOMETRY_FEATURE]
	if (!mode.harness && !mode.version) features.push(REVEAL_GEOMETRY_FEATURE, REGION_STATUS_GEOMETRY_FEATURE, WIDGET_EVENTS_FEATURE, FAILURE_REPORTS_FEATURE, CHECKS_REPORTS_FEATURE, BASE_STATE_FEATURE)
	return features
}
