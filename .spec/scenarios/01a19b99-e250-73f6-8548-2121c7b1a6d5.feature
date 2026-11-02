Feature: A failed capture keeps the previous thumbnail, now stale, and shows no error
  # Source: [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480); issue #481 https://github.com/DevilTea/uiux/issues/481.
  # Test: code@a2b2a01 `tests/thumbnail-http.test.ts#L241` "keeps the stored thumbnail, now stale, with no error, and a request within the failure interval queues nothing". https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/tests/thumbnail-http.test.ts#L241
  # Test: code@a2b2a01 `tests/thumbnail-service.test.ts#L270` "changes no stored thumbnail, leaves it stale, and is not queued again by a request within 60 seconds". https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/tests/thumbnail-service.test.ts#L270
  # Status: built as of a2b2a01.
  @spec:id:01a19b99-e250-79a9-b870-e9a9e79369f9
  @spec:demonstrates:01a19b99-d6a9-7208-912e-f154133e553b
  @spec:demonstrates:01a19b99-d760-7e54-9a5e-1d98e9306de7
  @spec:demonstrates:01a19b99-ddf6-7460-88e7-55ad4aa5fbba
  @spec:demonstrates:01a19bac-eaeb-777f-b498-2e1c75ec706b
  Scenario: A failed capture keeps the previous thumbnail, now stale, and shows no error
    Given a View with a fresh thumbnail, in a Workspace whose capture browser cannot be launched
    When the View is changed
    When the quiet period ends
    When a member opens Overview's Views tab in the grid layout
    Then the stored thumbnail is unchanged and its state is stale
    Then the card shows the previous image with a stale indicator and no error marker
    Then the request queues nothing for the View, so its card does not show that it is being refreshed
