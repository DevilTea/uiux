Feature: Workspace migration
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c5 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814; #7 c9 d19 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095; #7 c6 d8 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815.
  # Test: code@a021f9e `tests/workspace-migration.test.ts#L141` "migrates v1 fixtures: bumps the manifest, backfills verified on v1 resolves only, and leaves other files byte-identical". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workspace-migration.test.ts#L141
  # Test: code@a021f9e `tests/workspace-migration.test.ts#L166` "is deterministic and idempotent". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workspace-migration.test.ts#L166
  # Test: code@a021f9e `tests/workspace-migration.test.ts#L233` "prints the dry-run plan, then migrates with the new manifest revision, then reports already current". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workspace-migration.test.ts#L233
  # Status: partly built as of 9691b8c: the chain ends at `schemaVersion` 3; see the Implementation gaps entries of 01a1144e-534c-7087-a504-76075f73df0d and 01a114ec-890a-73a1-808b-cb08087a9597 in their owner.
  # Note: Steps made version-neutral because Discussion #139 raised the current version; the tests above check the chain to `schemaVersion` 3.
  @spec:id:01a118a1-d046-7443-87a8-6f196b38fc19
  @spec:demonstrates:01a1144e-501c-746b-9f23-4cd321628f7c
  @spec:demonstrates:01a1144e-502f-7a30-bf11-69d72ea164db
  @spec:demonstrates:01a1144e-5605-722c-a662-2b483ddaad73
  Scenario: A migration chains its steps once, then reports the Workspace current
    Given a Workspace at `schemaVersion` 1 with a thread resolved before resolutions existed
    When an operator runs `uiux migrate` on it twice
    Then the first run reaches the current `schemaVersion` with that resolution recorded as verified, and prints every step, the changed files and the new manifest revision
    Then the second run reports the Workspace as already current
