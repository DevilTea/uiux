Feature: A burst of edits is captured once, after the quiet period
  # Source: [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480); issue #481 https://github.com/DevilTea/uiux/issues/481.
  # Test: code@a2b2a01 `tests/thumbnail-service.test.ts#L102` "captures a burst of writes once, after 10 seconds without a write (Scenario 01a19b99-e1bc-7f09-b7a8-b205513d1d7a)". https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/tests/thumbnail-service.test.ts#L102
  # Test: code@a2b2a01 `tests/thumbnail-http.test.ts#L175` "captures the changed View once, announces thumbnail.changed with only the key, and a Spec-only edit captures nothing". https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/tests/thumbnail-http.test.ts#L175
  # Status: built as of a2b2a01.
  @spec:id:01a19b99-e1bc-7f09-b7a8-b205513d1d7a
  @spec:demonstrates:01a19b99-ce21-7b2c-b039-f9afa8f95a97
  @spec:demonstrates:01a19b99-d221-715d-979a-1977a210a7b2
  @spec:demonstrates:01a19b99-d2cb-79ae-9e3d-ba6c24bc1f6a
  @spec:demonstrates:01a19b99-d383-7c4f-ad37-402eca1ef90e
  Scenario: A burst of edits is captured once, after the quiet period
    Given a Workspace whose View has a fresh thumbnail
    When the View is changed three times, each within 10 seconds of the previous change
    When the View is then left unchanged for 10 seconds
    Then exactly one thumbnail capture of the View runs, and none ran while the changes continued
    Then the View's thumbnail is fresh for its new render inputs once the capture is stored
