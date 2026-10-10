Feature: Version history
  # Source: Discussion #140 (Part 15, permission keys and role presets), Interactions 2; R7; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: built as of 98672a4.
  # Test: code@98672a4 `tests/history-restore.test.ts#L606` "refuses a member holding history.restore but not views.write, naming views.write, and leaves the View unchanged (Scenario 01a11c09-d8ce)". https://github.com/DevilTea/uiux/blob/98672a48d3d0babd56b8d471322cb3eea13f0d7f/tests/history-restore.test.ts#L606
  @spec:id:01a11c09-d8ce-7b6a-aa80-eef991422b2f
  @spec:demonstrates:01a11485-f9bd-78a3-a1d0-1b4f64e9883e
  @spec:demonstrates:01a11c09-a42a-7d6b-bb5e-01d7cf1ce2de
  @spec:demonstrates:01a11c09-c648-71be-a550-2ecabf12f5d0
  Scenario: Restoring a View needs its write key
    Given a human member holding `history.restore` but not `views.write`
    When the member restores a View to an earlier version on a cookie session
    Then the restore is refused with `auth.scope_denied` whose `requiredKeys` is `views.write`
    Then the View is unchanged
