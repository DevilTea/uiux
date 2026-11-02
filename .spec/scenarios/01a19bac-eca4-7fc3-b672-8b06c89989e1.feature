Feature: Continuous edits are captured at the ceiling, not postponed forever
  # Source: [#480 owner answers 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, the three answers](https://github.com/DevilTea/uiux/discussions/480#discussioncomment-19347706); issue #481 https://github.com/DevilTea/uiux/issues/481.
  # Note: No test exists yet; the implementation PR of issue #481 adds the Test lines.
  # Status: Not built as of be419253, tracked in issue #481 (https://github.com/DevilTea/uiux/issues/481).
  @spec:id:01a19bac-eca4-78e9-a9b8-f522b0c9af04
  @spec:demonstrates:01a19b99-ce21-7b2c-b039-f9afa8f95a97
  @spec:demonstrates:01a19bac-ea4d-79eb-9c1b-0c887270b5d5
  Scenario: Continuous edits are captured at the ceiling, not postponed forever
    Given a Workspace whose View has a fresh thumbnail
    When the View is changed every 5 seconds for 90 seconds
    Then a thumbnail capture pass starts no later than 60 seconds after the first change
    Then the changes that follow are covered by a later pass once they too have waited the quiet period or the ceiling
