Feature: The changes view stores nothing and offers no write action
  # Source: [#491 P1: version history is Git's, owner acceptance](https://github.com/DevilTea/uiux/discussions/491#discussioncomment-19699447): the view reads through `git`, stores nothing and is read-only; issue #492 https://github.com/DevilTea/uiux/issues/492.
  # Note: No test exists yet; the implementation PR of issue #492 adds the Test lines.
  # Status: Not built as of fcad4fef, tracked in issue #492 (https://github.com/DevilTea/uiux/issues/492).
  @spec:id:01a1ece9-a2d8-7eda-a9ed-ada7e38c64e4
  @spec:demonstrates:01a1ece7-910f-7bb4-aebe-ec9cff221ffc
  @spec:demonstrates:01a1ece7-91a3-709c-830d-42ff0393217a
  Scenario: The changes view stores nothing and offers no write action
    Given a Workspace inside a Git work tree with an uncommitted edit to a View
    When a Reviewer opens the view of changes since the Git base and turns its toggle on and off
    Then no file under the Workspace or under `$UIUX_HOME` is created or changed
    Then the view offers no action that writes, restores or reverts a resource
