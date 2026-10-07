Feature: Workspace migration
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 body: Canonical Decision Index item 2 https://github.com/DevilTea/uiux/discussions/1; #1 c152 d2 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18656497; #7 c5 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814; #7 c9 d19 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Test: code@a021f9e `tests/review-schema-v3.test.ts#L300` "opens a v2 Workspace as migration_required and blocks every Review mutation, including the new ones". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-schema-v3.test.ts#L300
  # Test: code@a021f9e `tests/workspace-migration.test.ts#L109` "opens a v1 Workspace as migration_required: readable, v1-decoded, and every Review mutation blocked". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workspace-migration.test.ts#L109
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cfab-7608-977a-15bc1920bb5f
  @spec:demonstrates:01a1144e-4fba-7152-8239-5c348a832b10
  @spec:demonstrates:01a1144e-4fcf-7b8a-8978-73b1a0cc31f4
  @spec:demonstrates:01a114ec-8931-798b-a550-5a918d013849
  Scenario: An older Workspace opens read-only and refuses mutations
    Given a Workspace at `schemaVersion` 2
    When a member replies to a Review thread in it
    Then the reply is refused with `workspace.migration_required` and nothing is written
    Then the Workspace's resources can still be read
