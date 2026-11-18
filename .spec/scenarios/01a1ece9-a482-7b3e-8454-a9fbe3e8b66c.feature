Feature: uiux dev refuses a Workspace copied outside a Git work tree
  # Source: [#491 P1: version history is Git's, owner acceptance](https://github.com/DevilTea/uiux/discussions/491#discussioncomment-19699447): Git is required in every runtime, so `uiux dev` refuses a Workspace outside a Git work tree (Risks); issue #492 https://github.com/DevilTea/uiux/issues/492.
  # Note: No test exists yet; the implementation PR of issue #492 adds the Test lines.
  # Status: Not built as of fcad4fef, tracked in issue #492 (https://github.com/DevilTea/uiux/issues/492).
  @spec:id:01a1ece9-a482-7d9f-a310-642ac10709d1
  @spec:demonstrates:01a1ece9-97ec-736f-99a3-80b76efc800b
  Scenario: uiux dev refuses a Workspace copied outside a Git work tree
    Given a Workspace directory copied without its Git metadata into a directory outside any Git work tree
    When an operator runs `uiux dev` on it
    Then the command exits with status 2 and reports `workspace.git_required`
    Then no server listens and no server hold is written
