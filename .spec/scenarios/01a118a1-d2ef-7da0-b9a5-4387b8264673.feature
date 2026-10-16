Feature: View Variants
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c155 d4 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18656662; #1 c9 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18554030; #1 c161 d2 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18669081.
  # Test: code@a021f9e `tests/view-runtime.test.ts#L177` "keeps the current Runtime untouched when an invalid Variant contains both valid and invalid overrides". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/view-runtime.test.ts#L177
  # Test: code@a021f9e `tests/view-runtime.test.ts#L326` "rejects a known non-author-writable State member before replacing the active Runtime". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/view-runtime.test.ts#L326
  # Test: code@48a04aa `tests/formal-capture.test.ts#L456` "refuses to capture an authored invalid Variant and stores nothing for it, while other contexts still capture". https://github.com/DevilTea/uiux/blob/48a04aaffc0f1a95f6f9feb3e3739efd3e274e3c/tests/formal-capture.test.ts#L456
  # Status: built as of a021f9e.
  # Note: This Scenario's steps show render; the formal capture test covers the Rule's capture and Evidence side (issue #119): the invalid Variant's context fails, nothing is stored for it, and no Evidence of it exists to cite.
  @spec:id:01a118a1-d2ef-7ec3-9ce8-0eebc952502a
  @spec:demonstrates:01a1144e-524c-7715-8fd8-d9ce46969cc6
  Scenario: An invalid Variant is never used, even partly
    Given a View whose Variant overrides one valid and one unknown State member of a Widget
    When the Preview switches to that Variant
    Then the switch is refused with the Variant's diagnostics
    Then the current Runtime keeps its state
