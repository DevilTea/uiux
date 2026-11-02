Feature: Continuous edits are captured at the ceiling, not postponed forever
  # Source: [#480 owner answers 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, the three answers](https://github.com/DevilTea/uiux/discussions/480#discussioncomment-19347706); issue #481 https://github.com/DevilTea/uiux/issues/481.
  # Test: code@a2b2a01 `tests/thumbnail-service.test.ts#L158` "starts a pass 60 seconds after the first change, whatever follows (Scenario 01a19bac-eca4-78e9-a9b8-f522b0c9af04)". https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/tests/thumbnail-service.test.ts#L158
  # Status: built as of a2b2a01.
  @spec:id:01a19bac-eca4-78e9-a9b8-f522b0c9af04
  @spec:demonstrates:01a19b99-ce21-7b2c-b039-f9afa8f95a97
  @spec:demonstrates:01a19bac-ea4d-79eb-9c1b-0c887270b5d5
  Scenario: Continuous edits are captured at the ceiling, not postponed forever
    Given a Workspace whose View has a fresh thumbnail
    When the View is changed every 5 seconds for 90 seconds
    Then a thumbnail capture pass starts no later than 60 seconds after the first change
    Then the changes that follow are covered by a later pass once they too have waited the quiet period or the ceiling
