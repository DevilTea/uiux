Feature: Command line
  # Source: Discussion #139 (Part 14, Product Kit), decision 2, A: Discovery; R1; owner pre-answer P20; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 9691b8c; see the Implementation gaps entry of 01a11bb1-9847-751f-a1ba-943ad111a02a in its owner.
  # Note: No test exists yet; tracked in issue #141.
  @spec:id:01a11bb1-bf1b-7e2f-9256-170e5d400195
  @spec:demonstrates:01a11bb1-9847-751f-a1ba-943ad111a02a
  Scenario: A command without a Workspace option finds the repository Workspace
    Given a repository whose root directory holds a Workspace in `.uiux/`
    When an operator runs `uiux dev` without `--workspace` from a subdirectory of the repository
    Then the server serves the Workspace in the repository's `.uiux/` directory
