Feature: Command-line interface
  # Source: [#379 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, option A with these defaults](https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19341867); issue #466 https://github.com/DevilTea/uiux/issues/466.
  # Test: code@d0c23e4 `tests/cli-evidence-server.test.ts#L201` "exits 1 when no server runs for the Workspace, and when --origin names one that does not answer". https://github.com/DevilTea/uiux/blob/d0c23e4e281d0c080e2808438f933372724e99bf/tests/cli-evidence-server.test.ts#L201
  # Test: code@d0c23e4 `tests/cli-evidence.test.ts#L252` "exits 1, saying how to start a server, when no server runs for the Workspace and no --origin is given". https://github.com/DevilTea/uiux/blob/d0c23e4e281d0c080e2808438f933372724e99bf/tests/cli-evidence.test.ts#L252
  # Status: built as of d0c23e4.
  @spec:id:01a19a18-d354-791a-80dd-6933affa50cd
  @spec:demonstrates:01a1144e-56d6-7b81-a611-25b8ef853abb
  @spec:demonstrates:01a19a17-1e66-7995-8300-15f49c6c2f81
  Scenario: The command is refused when no uiux dev server runs for the Workspace
    Given an initialized Workspace that no uiux dev server serves
    Given a Token in the UIUX_TOKEN environment variable
    When the operator runs `uiux evidence capture --view <id>` without --origin
    Then the command exits with status 1 and tells the operator to start uiux dev or pass --origin
