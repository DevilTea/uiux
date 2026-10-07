Feature: View Variants
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c155 d4 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18656662; #1 c9 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18554030; #1 c161 d2 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18669081.
  # Test: code@a021f9e `tests/view-runtime.test.ts#L177` "keeps the current Runtime untouched when an invalid Variant contains both valid and invalid overrides". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/view-runtime.test.ts#L177
  # Test: code@a021f9e `tests/view-runtime.test.ts#L326` "rejects a known non-author-writable State member before replacing the active Runtime". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/view-runtime.test.ts#L326
  # Status: built as of a021f9e.
  # Note: The tests cover render only; refusing formal capture or Review Evidence of an invalid Variant, also part of the Rule, has no test at the baseline; tracked in issue #119 (https://github.com/DevilTea/uiux/issues/119).
  @spec:id:01a118a1-d2ef-7ec3-9ce8-0eebc952502a
  @spec:demonstrates:01a1144e-524c-7715-8fd8-d9ce46969cc6
  Scenario: An invalid Variant is never used, even partly
    Given a View whose Variant overrides one valid and one unknown State member of a Widget
    When the Preview switches to that Variant
    Then the switch is refused with the Variant's diagnostics
    Then the current Runtime keeps its state
