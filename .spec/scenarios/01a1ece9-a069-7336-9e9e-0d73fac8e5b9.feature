Feature: The changes view compares the working tree with HEAD by default
  # Source: [#491 P1: version history is Git's, owner acceptance](https://github.com/DevilTea/uiux/discussions/491#discussioncomment-19699447): the default base is `HEAD` against the working tree (Settled details item 1); issue #492 https://github.com/DevilTea/uiux/issues/492.
  # Note: No test exists yet; the implementation PR of issue #492 adds the Test lines.
  # Status: Not built as of fcad4fef, tracked in issue #492 (https://github.com/DevilTea/uiux/issues/492).
  @spec:id:01a1ece9-a069-7c79-8f70-a0ed301c732f
  @spec:demonstrates:01a1ece7-8e23-77a8-9f34-b9c479043ca8
  @spec:demonstrates:01a1ece7-8f2f-7565-a11f-6d5ac9b5bab3
  @spec:demonstrates:01a1ece7-8fe1-7d17-8ef4-c706259e5331
  Scenario: The changes view compares the working tree with HEAD by default
    Given a Workspace inside a Git work tree whose committed View has an uncommitted edit
    When a Reviewer opens the view of changes since the Git base
    Then the View is listed as changed
    Then selecting it shows the edit as semantic differences from the View as committed at `HEAD`
