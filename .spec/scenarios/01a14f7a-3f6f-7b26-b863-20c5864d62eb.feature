Feature: Command-line interface
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R3 https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner confirmations A2: `uiux artifacts gc` refuses an unusable Workspace root https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #58 https://github.com/DevilTea/uiux/issues/58.
  # Test: code@4fc05a7 `tests/artifacts-gc.test.ts#L276` "refuses an unusable Workspace root with status 2 before any lock or read" (an older and a newer `schemaVersion`, a foreign manifest, a missing `product-kit.json`). https://github.com/DevilTea/uiux/blob/4fc05a7e72ee40e71415d3b1baeaec317585722f/tests/artifacts-gc.test.ts#L276
  # Status: built as of 4fc05a7.
  @spec:id:01a14f7a-3f6f-7100-8f3f-0008dd0f462e
  @spec:demonstrates:01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9
  @spec:demonstrates:01a14e30-314b-7ee5-b85e-c8a926013beb
  Scenario: Artifact cleanup refuses an unusable Workspace root before touching it
    Given a Workspace whose manifest has `schemaVersion` 5 and whose artifact store holds a blob that no root reaches
    When an operator runs `uiux artifacts gc --workspace` on it
    Then the command exits with status 2 and its message names `schemaVersion` 5
    Then the blob is still in the store and no file of the Workspace has changed
