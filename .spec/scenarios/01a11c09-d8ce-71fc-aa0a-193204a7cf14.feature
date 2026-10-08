Feature: Version history
  # Source: Discussion #140 (Part 15, permission keys and role presets), Interactions 2; R7; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: not built as of 0c26ead; see the Implementation gaps entry of 01a11c09-c648-71be-a550-2ecabf12f5d0 in its owner.
  # Note: No test exists yet; tracked in issue #142.
  @spec:id:01a11c09-d8ce-7b6a-aa80-eef991422b2f
  @spec:demonstrates:01a11c09-a42a-7d6b-bb5e-01d7cf1ce2de
  @spec:demonstrates:01a11c09-c648-71be-a550-2ecabf12f5d0
  Scenario: Restoring a View needs its write key
    Given a human member holding `history.restore` but not `views.write`
    When the member restores a View to an earlier version on a cookie session
    Then the restore is refused with `auth.scope_denied` whose `requiredKeys` is `views.write`
    Then the View is unchanged
