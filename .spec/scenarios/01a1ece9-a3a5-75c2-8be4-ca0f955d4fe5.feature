Feature: uiux init refuses a directory outside a Git work tree
  # Source: [#491 P1: version history is Git's, owner acceptance](https://github.com/DevilTea/uiux/discussions/491#discussioncomment-19699447): `uiux init` refuses to run outside a Git work tree and no longer falls back to `<cwd>/.uiux/`; issue #492 https://github.com/DevilTea/uiux/issues/492.
  # Note: No test exists yet; the implementation PR of issue #492 adds the Test lines.
  # Status: Not built as of fcad4fef, tracked in issue #492 (https://github.com/DevilTea/uiux/issues/492).
  @spec:id:01a1ece9-a3a5-701a-87b3-c9fcfcb3371d
  @spec:demonstrates:01a1ece9-97ec-736f-99a3-80b76efc800b
  Scenario: uiux init refuses a directory outside a Git work tree
    Given a directory that is not inside any Git work tree
    When an operator runs `uiux init` there without `--workspace`
    Then the command exits with status 2 and reports `workspace.git_required`
    Then no `.uiux/` directory has been created
