Feature: Handoff export
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 9, R34 and R35 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Test: code@167195a `tests/handoff-closure.test.ts#L1157` "records the entry-module fallback for an Adapter without source mappings". https://github.com/DevilTea/uiux/blob/167195a6e7b0b8e0e10f7771739219f90def8926/tests/handoff-closure.test.ts#L1157
  # Status: built as of 167195a.
  @spec:id:01a1745c-3771-7fc6-bcdf-331722872a52
  @spec:demonstrates:01a11a5a-5845-7fc4-99b8-b0fe62039460
  Scenario: A Widget type without a source mapping is traced to its Adapter entry module and says so
    Given an Adapter that declares no source mapping
    When a Handoff bundle is exported for a View that uses a Widget type the Adapter provides
    Then the semantic and the renderer source are the Adapter entry module
    Then each source reference has the selection `entry-module-fallback`
