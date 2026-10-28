Feature: Workspace apply
  # Source: Discussion #379 (closed loop) [#379 body: D2: author on a temporary copy, apply back through a PR](https://github.com/DevilTea/uiux/discussions/379); owner acceptance 2026-10-28 https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19234465; scenario chosen in its `.spec/` PR.
  # Status: not built; tracked in issue #381 (https://github.com/DevilTea/uiux/issues/381).
  @spec:id:01a18121-7a65-7f1b-8e98-77ff0b878991
  @spec:demonstrates:01a18120-f7f0-7903-975a-8c52ef855ab4
  @spec:demonstrates:01a18121-0129-735d-adeb-b5a6f973de3c
  @spec:demonstrates:01a18121-034e-75a9-92ad-a63caa627323
  @spec:demonstrates:01a18121-0709-7f49-a899-74082c458203
  Scenario: Apply lands only the canonical files of a temporary copy
    Given a Git-tracked Workspace whose directory has no uncommitted change
    Given a temporary copy of it in which an Agent created a View through MCP and in which `kit/` and `history/` also differ
    When an operator runs `uiux workspace apply` with `--from` the copy
    Then `git diff` shows only the new View file and the artifact blobs that its Evidence references
    Then `kit/`, `history/`, the runtime files and `$UIUX_HOME` are unchanged and no Checkpoint was written
