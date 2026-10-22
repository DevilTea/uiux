Feature: Evidence freshness
  # Source: Discussion #10 comment 4 (2026-10-07), owner ruling on issue #57 https://github.com/DevilTea/uiux/discussions/10#discussioncomment-18793180, decision 2; Discussion #139 decision 11 (graph-wide content digests) https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Test: code@a850cd1 `tests/handoff-closure.test.ts#L1685` "stales the capture once an Adapter module changes". https://github.com/DevilTea/uiux/blob/a850cd1bb44bb1c02624381eb9c7584554a257ad/tests/handoff-closure.test.ts#L1685
  # Test: code@a850cd1 `tests/evidence-staleness.test.ts#L277` "is stale once the active set differs in selection, order, content or configuration (Rule 01a115cd-c6de-…)". https://github.com/DevilTea/uiux/blob/a850cd1bb44bb1c02624381eb9c7584554a257ad/tests/evidence-staleness.test.ts#L277
  # Status: built as of 881f266.
  @spec:id:01a16486-9d76-7e5c-a1c4-eab947ef4461
  @spec:demonstrates:01a115cd-c6de-7744-be27-715bec2e7fef
  Scenario: Editing an Adapter module makes a capture stale
    Given a fresh formal capture of a View made under the current active Adapter set
    When an author edits the module of one of those Adapters
    Then the capture is stale with the reason that its Adapter changed since capture
