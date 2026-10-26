Feature: Preview failure diagnostics
  # Source: issue #339 (https://github.com/DevilTea/uiux/issues/339); #241 owner ruling 3 of 2026-10-26, a `protocol.invalid_state` report for an established violation. https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851
  # Test: code@e466f98 `tests/preview-failure-report.test.ts#L341` "takes traffic of its own generation before the acknowledgement for an out-of-order violation, and holds the report until the ACK". https://github.com/DevilTea/uiux/blob/e466f985d233bd9afe4ee5562c3d21b8d7e39f76/tests/preview-failure-report.test.ts#L341
  # Test: code@e466f98 `tests/preview-failure-report.test.ts#L367` "takes a capability.declare of its own generation after the acknowledgement for a violation and reports it at once". https://github.com/DevilTea/uiux/blob/e466f985d233bd9afe4ee5562c3d21b8d7e39f76/tests/preview-failure-report.test.ts#L367
  # Status: built as of e466f98 (issue #339).
  @spec:id:01a178c5-82a0-7ede-a198-80d282e159ef
  @spec:demonstrates:01a11a59-def9-797a-8d08-5e4b02ecd900
  @spec:demonstrates:01a11a70-4261-7155-8aed-28bed7a89064
  Scenario: A runtime reports Workbench traffic that arrives before its acknowledgement as invalid_state
    Given a runtime generation that declared failure reports has declared its capabilities and not yet received the acknowledgement
    When a `geometry.acquire.request` of that session and generation reaches it
    When the acknowledgement then arrives
    Then the runtime sends exactly one generation-scoped `failure.report` with the reason `protocol.invalid_state`, after the acknowledgement
    Then the Workbench ends that generation as protocol-invalid
