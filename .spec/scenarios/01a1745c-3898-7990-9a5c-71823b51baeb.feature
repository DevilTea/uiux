Feature: Formal Evidence capture
  # Source: Discussion #130 (Part 12), decision 10, R36 https://github.com/DevilTea/uiux/discussions/130; owner acceptance 2026-10-08, owner attention 3, amends the third acceptance criterion of issue #93 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Test: code@167195a `tests/formal-capture.test.ts#L207` "proves fresh isolated runtime: widget state mutated in page does not bleed into formal capture". https://github.com/DevilTea/uiux/blob/167195a6e7b0b8e0e10f7771739219f90def8926/tests/formal-capture.test.ts#L207
  # Status: built as of 167195a.
  @spec:id:01a1745c-3898-7918-ba62-fa4ddd16ddb4
  @spec:demonstrates:01a115cd-cecb-747b-b28d-aa083893bff2
  Scenario: A formal capture record names the engine that produced it
    Given a View with its Workspace resources
    When a formal capture is taken
    Then the Evidence record's versions name `uiux`, `playwright` and `chromium`
