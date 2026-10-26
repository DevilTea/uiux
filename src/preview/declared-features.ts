import { CHECKS_REPORTS_FEATURE } from './protocol/checks-report'
import { FAILURE_REPORTS_FEATURE } from './protocol/failure-report'
import { MULTI_TARGET_GEOMETRY_FEATURE } from './protocol/schema'
import { WIDGET_EVENTS_FEATURE } from './protocol/widget-events'

/**
 * The capability features a runtime generation declares. `widget.events`, `failure.reports` and
 * `checks.reports` belong to a Workbench Preview (decision 10; issues #312 and #347): a formal
 * capture has no Workbench parent to arm it or to read a report, and a version frame is read-only
 * with no recovery of its own and never feeds Checks.
 */
export function declaredRuntimeFeatures(mode: Readonly<{ harness: boolean; version: boolean }>): string[] {
	const features = ['geometry', MULTI_TARGET_GEOMETRY_FEATURE]
	if (!mode.harness && !mode.version) features.push(WIDGET_EVENTS_FEATURE, FAILURE_REPORTS_FEATURE, CHECKS_REPORTS_FEATURE)
	return features
}
