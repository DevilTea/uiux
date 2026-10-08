Feature: Handoff export
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 9, R34 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a115cd-cbcc-7ae2-856e-b0fe1248c1ac in its owner.
  # Note: No test exists yet.
  @spec:id:01a11a5b-1c07-79b5-89fc-dc04afdde464
  @spec:demonstrates:01a115cd-cbcc-7ae2-856e-b0fe1248c1ac
  @spec:demonstrates:01a115cd-d776-7b2e-ab7a-4199f7e4695f
  Scenario: A mapped Design System source is snapshotted with its package version
    Given an Adapter whose source mapping names a file of a Design System package as the Design System source of a Widget type
    When a Handoff bundle is exported for a View that uses that Widget type
    Then the bundle snapshots that file by content identity
    Then its source reference names the package, the package version as revision, the original path and the selection `adapter-mapping`
