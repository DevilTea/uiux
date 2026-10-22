Feature: Evidence freshness
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 6, R26 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Test: code@a850cd1 `tests/handoff-closure.test.ts#L1695` "stales the capture once an Adapter's configuration changes". https://github.com/DevilTea/uiux/blob/a850cd1bb44bb1c02624381eb9c7584554a257ad/tests/handoff-closure.test.ts#L1695
  # Status: built as of 881f266.
  # Note: The test changes the configuration through the Product Kit file, as the Product Kit page's write does. Discussion #139 (Part 14) moved Adapter configuration to the Product Kit page, so the step names that page.
  @spec:id:01a11a5b-1b82-75ab-b08d-a630609e3b80
  @spec:demonstrates:01a115cd-c6de-7744-be27-715bec2e7fef
  Scenario: Editing an Adapter configuration makes a capture stale
    Given a fresh formal capture of a View made under its Adapter entry's current configuration
    When an author changes that Adapter entry's configuration on the Product Kit page
    Then the capture is stale with the reason that its Adapter changed since capture
