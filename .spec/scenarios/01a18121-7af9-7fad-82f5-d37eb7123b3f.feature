Feature: Workspace apply
  # Source: Discussion #379 (closed loop) [#379 body: D2: Apply refuses](https://github.com/DevilTea/uiux/discussions/379) (a dirty work tree); owner acceptance 2026-10-28 https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19234465; scenario chosen in its `.spec/` PR.
  # Status: not built; tracked in issue #381 (https://github.com/DevilTea/uiux/issues/381).
  @spec:id:01a18121-7af9-7850-a87a-835923649275
  @spec:demonstrates:01a18120-f879-7730-8207-66234a8392cd
  @spec:demonstrates:01a18121-02c4-751d-be6d-576c9a7971d5
  Scenario: Apply refuses a Workspace with an uncommitted change
    Given a Git-tracked Workspace with an untracked file under its directory
    When an operator runs `uiux workspace apply` on it
    Then the command exits with status 1 and the code `apply.work_tree_dirty`
    Then no file of the Workspace has changed
