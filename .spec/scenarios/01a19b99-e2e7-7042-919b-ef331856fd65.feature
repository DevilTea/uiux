Feature: Opening the Views tab queues missing thumbnails, and the cards fill in as they are stored
  # Source: [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480); issue #481 https://github.com/DevilTea/uiux/issues/481.
  # Test: code@a2b2a01 `tests/view-thumbnails-browser.test.ts#L111` "requests the thumbnails when the tab opens, shows a placeholder, then replaces it with the 480 px image in place, and the card stays a link named by its View". https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/tests/view-thumbnails-browser.test.ts#L111
  # Test: code@a2b2a01 `tests/thumbnail-service.test.ts#L190` "runs one capture at a time and queues a View once". https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/tests/thumbnail-service.test.ts#L190
  # Status: built as of a2b2a01.
  @spec:id:01a19b99-e2e7-7758-b94d-b440c87581cf
  @spec:demonstrates:01a19b99-d42e-7b72-b30b-480057b269d9
  @spec:demonstrates:01a19b99-d509-708b-8d53-ac59f3ea0413
  @spec:demonstrates:01a19b99-dd5f-79bb-bfb6-d1446d6b6526
  @spec:demonstrates:01a19b99-df3d-7654-ab9f-253a58229524
  @spec:demonstrates:01a19b99-dfe8-7396-95d8-8e0cf1acf533
  Scenario: Opening the Views tab queues missing thumbnails, and the cards fill in as they are stored
    Given a Workspace with two Views that have no thumbnail
    Given a member who holds workspace.read and has chosen the grid layout
    When the member opens Overview's Views tab
    Then each card shows a placeholder
    Then the server captures the two thumbnails one at a time
    Then each card replaces its placeholder with its thumbnail when it is stored, without a reload
