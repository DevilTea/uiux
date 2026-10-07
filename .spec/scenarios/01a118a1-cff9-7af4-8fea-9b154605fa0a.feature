Feature: Workspace migration
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c5 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814; #7 c9 d19 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095; #7 c6 d8: one `1 -> 2` step `uiux.v1-to-v2` https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815.
  # Test: code@a021f9e `tests/workspace-migration.test.ts#L129` "plans a dry run in memory without writing anything". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workspace-migration.test.ts#L129
  # Test: code@a021f9e `tests/workspace-migration.test.ts#L233` "prints the dry-run plan, then migrates with the new manifest revision, then reports already current". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workspace-migration.test.ts#L233
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cff9-75ac-82b2-35c863ed571a
  @spec:demonstrates:01a1144e-5054-7fc1-9c23-49ae8c9886c1
  @spec:demonstrates:01a1144e-5605-722c-a662-2b483ddaad73
  @spec:demonstrates:01a114ec-890a-73a1-808b-cb08087a9597
  Scenario: A migration dry run plans the upgrade and writes nothing
    Given a Workspace at `schemaVersion` 1
    When an operator runs `uiux migrate --dry-run` on it
    Then it prints the steps `uiux.v1-to-v2` and `uiux.v2-to-v3`, the version change and the files it would change
    Then no file of the Workspace changes
