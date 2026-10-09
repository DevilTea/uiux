Feature: Workspace migration
  # Source: Discussion #7 owner rulings 2026-10-09, ruling 3: Part 7 Scenarios for capture, the inbox link, the stale-key fallback, muted-pin activation and migration https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18820343; #7 c11 decision 9 and schema delta: the manifest-only step `uiux.v3-to-v4` with no backfill https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18797092.
  # Test: code@d3bc3a3 `tests/review-schema-v4.test.ts#L210` "bumps only the manifest, backfills no renderContext, and is idempotent". https://github.com/DevilTea/uiux/blob/d3bc3a3502315c0105f0cb2d3c2b5c9e43256fa5/tests/review-schema-v4.test.ts#L210
  # Test: code@d3bc3a3 `tests/workspace-migration.test.ts#L309` "replays the dogfood uiux.v3-to-v4 migration through the CLI: one step, only the manifest changes, re-runs are no-ops". https://github.com/DevilTea/uiux/blob/d3bc3a3502315c0105f0cb2d3c2b5c9e43256fa5/tests/workspace-migration.test.ts#L309
  # Status: partly built as of d3bc3a3: `uiux.v3-to-v4` changes only the manifest and backfills no `renderContext`, but the chain ends at `schemaVersion` 4; see the Implementation gaps entry of 01a114ec-890a-73a1-808b-cb08087a9597 in its owner.
  @spec:id:01a11e0e-4569-79af-8702-a703c151e278
  @spec:demonstrates:01a114ec-890a-73a1-808b-cb08087a9597
  @spec:demonstrates:01a1170f-baf0-7eea-a904-7367227c10b3
  Scenario: Migrating to schemaVersion 4 gives existing threads no render context
    Given a Workspace at `schemaVersion` 3 with Widget-anchored Review threads
    When an operator runs `uiux migrate` on it
    Then the step `uiux.v3-to-v4` changes only the manifest
    Then every Review thread file is byte-identical, so no thread records a render context
