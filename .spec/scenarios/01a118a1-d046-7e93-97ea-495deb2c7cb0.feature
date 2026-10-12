Feature: Workspace migration
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c5 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814; #7 c9 d19 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095; #7 c6 d8 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815.
  # Test: code@c384e72 `tests/workspace-migration.test.ts#L155` "migrates v1 fixtures: bumps the manifest, backfills verified on v1 resolves only, and leaves other files byte-identical". https://github.com/DevilTea/uiux/blob/c384e72341032d267df8e8d6d0bc690117e3224b/tests/workspace-migration.test.ts#L155
  # Test: code@c384e72 `tests/workspace-migration.test.ts#L181` "is deterministic and idempotent". https://github.com/DevilTea/uiux/blob/c384e72341032d267df8e8d6d0bc690117e3224b/tests/workspace-migration.test.ts#L181
  # Test: code@c384e72 `tests/workspace-migration.test.ts#L249` "prints the dry-run plan, then migrates with the new manifest revision, then reports already current". https://github.com/DevilTea/uiux/blob/c384e72341032d267df8e8d6d0bc690117e3224b/tests/workspace-migration.test.ts#L249
  # Test: code@3b20412 `tests/workspace-migration.test.ts#L295` "prints the dry-run plan, then migrates with the new manifest revision, then reports already current". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/workspace-migration.test.ts#L295
  # Test: code@39e99da `tests/workspace-migration.test.ts#L297` "prints the dry-run plan, then migrates with the new manifest revision, then reports already current". https://github.com/DevilTea/uiux/blob/39e99da86eec36860acb97077deddd836cce9a33/tests/workspace-migration.test.ts#L297
  # Status: built as of 39e99da: the chain reaches `schemaVersion` 6 through `uiux.v5-to-v6`.
  # Note: Steps made version-neutral because Discussion #139 raised the current version; the tests at c384e72 check the chain to `schemaVersion` 4, the one at 3b20412 the chain to `schemaVersion` 5, the one at 39e99da the chain to `schemaVersion` 6.
  @spec:id:01a118a1-d046-7443-87a8-6f196b38fc19
  @spec:demonstrates:01a1144e-501c-746b-9f23-4cd321628f7c
  @spec:demonstrates:01a1144e-502f-7a30-bf11-69d72ea164db
  @spec:demonstrates:01a1144e-5605-722c-a662-2b483ddaad73
  Scenario: A migration chains its steps once, then reports the Workspace current
    Given a Workspace at `schemaVersion` 1 with a thread resolved before resolutions existed
    When an operator runs `uiux migrate` on it twice
    Then the first run reaches the current `schemaVersion` with that resolution recorded as verified, and prints every step, the changed files and the new manifest revision
    Then the second run reports the Workspace as already current
