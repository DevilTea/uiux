Feature: A failed capture keeps the previous thumbnail, now stale, and shows no error
  # Source: [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480); issue #481 https://github.com/DevilTea/uiux/issues/481.
  # Note: No test exists yet; the implementation PR of issue #481 adds the Test lines.
  # Status: Not built as of be419253, tracked in issue #481 (https://github.com/DevilTea/uiux/issues/481).
  @spec:id:01a19b99-e250-79a9-b870-e9a9e79369f9
  @spec:demonstrates:01a19b99-d6a9-7208-912e-f154133e553b
  @spec:demonstrates:01a19b99-d760-7e54-9a5e-1d98e9306de7
  @spec:demonstrates:01a19b99-ddf6-7460-88e7-55ad4aa5fbba
  @spec:demonstrates:01a19bac-eaeb-777f-b498-2e1c75ec706b
  Scenario: A failed capture keeps the previous thumbnail, now stale, and shows no error
    Given a View with a fresh thumbnail, in a Workspace whose capture browser cannot be launched
    When the View is changed and the quiet period ends
    When a member opens Overview's Views tab in the grid layout
    Then the stored thumbnail is unchanged and its state is stale
    Then the card shows the previous image with a stale indicator and no error
