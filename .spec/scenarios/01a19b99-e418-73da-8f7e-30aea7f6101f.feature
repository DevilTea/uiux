Feature: Deleting a thumbnail from the host cache changes no readiness or Evidence
  # Source: [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480); issue #481 https://github.com/DevilTea/uiux/issues/481.
  # Note: No test exists yet; the implementation PR of issue #481 adds the Test lines.
  # Status: Not built as of be419253, tracked in issue #481 (https://github.com/DevilTea/uiux/issues/481).
  @spec:id:01a19b99-e418-7af5-936b-1c1285888dfe
  @spec:demonstrates:01a19b99-d0f0-7233-b0c1-7569a51379ee
  @spec:demonstrates:01a19b99-d42e-7b72-b30b-480057b269d9
  Scenario: Deleting a thumbnail from the host cache changes no readiness or Evidence
    Given a View with a fresh formal capture and a fresh thumbnail
    When the thumbnail file is deleted from the host cache
    Then the View's readiness, its Evidence list and a Handoff assessment are unchanged
    Then the thumbnail is captured again the next time the Views tab is opened
