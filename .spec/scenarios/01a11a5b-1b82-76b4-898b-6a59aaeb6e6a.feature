Feature: Evidence freshness
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 6, R26 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a115cd-c6de-7744-be27-715bec2e7fef in its owner.
  # Note: No test exists yet.
  @spec:id:01a11a5b-1b82-75ab-b08d-a630609e3b80
  @spec:demonstrates:01a115cd-c6de-7744-be27-715bec2e7fef
  Scenario: Editing an Adapter configuration makes a capture stale
    Given a fresh formal capture of a View made under its Adapter entry's current configuration
    When an author changes that Adapter entry's configuration in Settings
    Then the capture is stale with the reason that its Adapter changed since capture
