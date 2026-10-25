Feature: Handoff export
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 9, R34 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Test: code@167195a `tests/handoff-closure.test.ts#L1089` "snapshots mapped files with their package, revision and path, and marks the others provenance-only or unavailable without blocking". https://github.com/DevilTea/uiux/blob/167195a6e7b0b8e0e10f7771739219f90def8926/tests/handoff-closure.test.ts#L1089
  # Status: built as of 167195a.
  @spec:id:01a11a5b-1c07-79b5-89fc-dc04afdde464
  @spec:demonstrates:01a115cd-cbcc-7ae2-856e-b0fe1248c1ac
  @spec:demonstrates:01a115cd-d776-7b2e-ab7a-4199f7e4695f
  Scenario: A mapped Design System source is snapshotted with its package version
    Given an Adapter whose source mapping names a file of a Design System package as the Design System source of a Widget type
    When a Handoff bundle is exported for a View that uses that Widget type
    Then the bundle snapshots that file by content identity
    Then its source reference names the package, the package version as revision, the original path and the selection `adapter-mapping`
