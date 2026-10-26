Feature: Preview failure diagnostics
  # Source: issue #339 (https://github.com/DevilTea/uiux/issues/339); #241 owner ruling 3 of 2026-10-26, a `runtime.unavailable` report when the runtime or its worker fails permanently. https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851
  # Test: code@e466f98 `tests/preview-geometry-producer.test.ts#L349` "stops for good and reports itself unavailable once when a frame pass throws". https://github.com/DevilTea/uiux/blob/e466f985d233bd9afe4ee5562c3d21b8d7e39f76/tests/preview-geometry-producer.test.ts#L349
  # Test: code@e466f98 `tests/preview-failure-report.test.ts#L405` "sends one generation-scoped runtime report that ends the generation without automatic recovery". https://github.com/DevilTea/uiux/blob/e466f985d233bd9afe4ee5562c3d21b8d7e39f76/tests/preview-failure-report.test.ts#L405
  # Status: built as of e466f98 (issue #339).
  # Note: no test runs the Preview page's wiring of the producer to the bridge (`app/pages/preview.vue`, `reportFailure`); the Preview runtime has no worker, so the geometry frame pass is the only permanent failure it detects.
  @spec:id:01a178c5-9b26-7f91-9447-df6e7ad21904
  @spec:demonstrates:01a11a59-def9-797a-8d08-5e4b02ecd900
  @spec:demonstrates:01a11a70-4261-7155-8aed-28bed7a89064
  Scenario: A runtime whose geometry frame pass throws reports itself unavailable
    Given an acknowledged runtime generation that declares failure reports has an open geometry stream
    When a frame pass of its geometry producer throws
    Then the runtime sends exactly one generation-scoped `failure.report` with the reason `runtime.unavailable` and measures no more Widgets
    Then the Workbench ends that generation and starts no automatic recovery
