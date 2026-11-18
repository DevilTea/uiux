Feature: Without a default branch the toggle is unavailable and HEAD stays the base
  # Source: [#491 P1: version history is Git's, owner acceptance](https://github.com/DevilTea/uiux/discussions/491#discussioncomment-19699447): the unavailable toggle without a default branch is chosen by the spec PR; issue #492 https://github.com/DevilTea/uiux/issues/492.
  # Test: code@7068132 `tests/git-changes.test.ts#L192` "makes the toggle unavailable when no default branch can be determined, and keeps HEAD as the base". https://github.com/DevilTea/uiux/blob/7068132c0bcb420dbaf7ab6505e17bb4c5f737f5/tests/git-changes.test.ts#L192
  # Test: code@7068132 `tests/changes-browser.test.ts#L111` "disables the toggle to the merge base, says why, and still lists the changes against HEAD". https://github.com/DevilTea/uiux/blob/7068132c0bcb420dbaf7ab6505e17bb4c5f737f5/tests/changes-browser.test.ts#L111
  # Status: built as of 9e7126e.
  @spec:id:01a1ece9-a20a-7b0e-b910-b396947a6797
  @spec:demonstrates:01a1ece7-9239-7a3f-931f-cbe92f83561f
  Scenario: Without a default branch the toggle is unavailable and HEAD stays the base
    Given a Workspace inside a Git work tree from which no default branch can be determined
    When a Reviewer opens the view of changes since the Git base
    Then the toggle to the merge base is unavailable
    Then the view still lists the changes against `HEAD`
