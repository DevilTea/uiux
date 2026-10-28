Feature: Workspace apply
  # Source: Discussion #379 (closed loop) [#379 body: D2: Apply refuses](https://github.com/DevilTea/uiux/discussions/379) (`--check` prints the plan and writes nothing); owner acceptance 2026-10-28 https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19234465; scenario chosen in its `.spec/` PR.
  # Status: not built; tracked in issue #381 (https://github.com/DevilTea/uiux/issues/381).
  @spec:id:01a18121-7b86-705c-ab3c-eb7e9aee673f
  @spec:demonstrates:01a18120-f64a-73e7-9463-b5039a4041d4
  @spec:demonstrates:01a18121-0682-73e5-b61c-db6bb0c9393d
  Scenario: A check run prints the plan and writes nothing
    Given a clean Git-tracked Workspace and a copy that holds one changed View and one removed Flow
    When an operator runs `uiux workspace apply --check`
    Then it prints a `changed` line for the View, a `removed` line for the Flow and the three counts
    Then it exits with status 0 and the Workspace is unchanged
