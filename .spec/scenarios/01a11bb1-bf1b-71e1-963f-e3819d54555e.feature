Feature: Command line
  # Source: Discussion #139 (Part 14, Product Kit), decision 2, A: Discovery; R1; owner pre-answer P20; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Test: code@3b20412 `tests/workspace-discovery.test.ts#L146` "uiux dev without --workspace from a subdirectory serves the repository Workspace in .uiux/". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/workspace-discovery.test.ts#L146
  # Status: built as of 3b20412.
  @spec:id:01a11bb1-bf1b-7e2f-9256-170e5d400195
  @spec:demonstrates:01a11bb1-9847-751f-a1ba-943ad111a02a
  Scenario: A command without a Workspace option finds the repository Workspace
    Given a repository whose root directory holds a Workspace in `.uiux/`
    When an operator runs `uiux dev` without `--workspace` from a subdirectory of the repository
    Then the server serves the Workspace in the repository's `.uiux/` directory
