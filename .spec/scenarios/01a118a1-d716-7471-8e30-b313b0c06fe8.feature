Feature: Workspace migration
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #7 c5 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814.
  # Test: code@a021f9e `tests/workspace-migration.test.ts#L257` "refuses the real run while a live UIUX server holds the Workspace, and ignores a stale hold". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workspace-migration.test.ts#L257
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d716-70a2-833a-f04aedf27405
  @spec:demonstrates:01a1144e-5067-7a2e-bd8d-e33a667033c2
  Scenario: A real migration refuses while a server serves the Workspace
    Given `uiux dev` serves a Workspace at `schemaVersion` 2
    When an operator runs `uiux migrate` on it
    Then the migration is refused and the Workspace is unchanged
