Feature: Artifact cleanup keeps the newest checks_run records and any that a root references, and deletes the older ones
  # Source: Discussion #241 owner ruling of 2026-10-26, item 1: retention of checks_run records https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851; issue #361 https://github.com/DevilTea/uiux/issues/361.
  # Test: code@ce2d8ba `tests/artifacts-gc.test.ts#L379` "keeps the newest checks_run records and any a root references, and deletes the older ones (owner ruling of 2026-10-26, item 1)". https://github.com/DevilTea/uiux/blob/ce2d8ba4c13805795f840fcfadecff3ad1ca5e01/tests/artifacts-gc.test.ts#L379
  # Status: built as of ce2d8ba.
  # Note: The test records 25 runs out of order through the Run Checks Evidence service and references the oldest from a Review submission; 20 + 1 stay.
  @spec:id:01a178bc-e8cb-7501-ab5a-5b6250ccce03
  @spec:demonstrates:01a14e30-31c0-7289-a944-74af9556eabf
  @spec:demonstrates:01a178bb-cffc-7de1-93da-18431060d9b1
  Scenario: Artifact cleanup keeps the newest checks_run records and any that a root references, and deletes the older ones
    Given a Workspace whose artifact store holds 25 checks_run Evidence records with distinct ranAt times
    Given a Review submission references the oldest of them
    When an operator runs `uiux artifacts gc` on it
    Then the command exits with status 0 and deletes only the 4 checks_run records that are neither among the 20 newest by ranAt nor referenced
    Then the 20 newest and the referenced one are still in the store
