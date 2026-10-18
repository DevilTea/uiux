Feature: Content-addressed artifact store
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R3: the roots of artifact cleanup (Evidence a Review submission references, Checkpoint blobs, the latest Evidence record per View and render context; Handoff blobs are not roots) and the explicit `artifacts gc` command https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner confirmations A2, the output https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #58 https://github.com/DevilTea/uiux/issues/58.
  # Test: code@4fc05a7 `tests/artifacts-gc.test.ts#L212` "deletes the unreachable blobs and keeps every root kind and what it reaches". https://github.com/DevilTea/uiux/blob/4fc05a7e72ee40e71415d3b1baeaec317585722f/tests/artifacts-gc.test.ts#L212
  # Test: code@4fc05a7 `tests/artifacts-gc.test.ts#L251` "dates a blob that a producer yields again at that time, so a repeated capture is the latest one". https://github.com/DevilTea/uiux/blob/4fc05a7e72ee40e71415d3b1baeaec317585722f/tests/artifacts-gc.test.ts#L251
  # Test: code@4fc05a7 `tests/artifacts-gc.test.ts#L320` "runs through the uiux binary, which lists it in help and refuses invalid usage with status 2" (the deleting run through `bin/uiux.mjs`). https://github.com/DevilTea/uiux/blob/4fc05a7e72ee40e71415d3b1baeaec317585722f/tests/artifacts-gc.test.ts#L320
  # Status: built as of 4fc05a7.
  # Note: "Latest" is the newest blob modification time per Evidence kind and execution context; the run also keeps every Evidence record that names its View's current revision (code@4fc05a7 `tests/artifacts-gc.test.ts#L231` "keeps every Evidence record that names the current revision of its View, whatever its time"), as the artifact store Feature's Notes record.
  @spec:id:01a14f79-f6a7-77cd-ba1f-a392074e4957
  @spec:demonstrates:01a115cd-c208-7a92-9582-69966f36e7fe
  @spec:demonstrates:01a115cd-c23e-7143-bd1e-7ffd9fcaa6f2
  @spec:demonstrates:01a14e30-30de-70c3-888f-63e8982353d7
  @spec:demonstrates:01a14e30-31c0-7289-a944-74af9556eabf
  Scenario: Artifact cleanup deletes only the blobs that no root reaches
    Given a Workspace whose artifact store holds an Evidence record that a Review submission references, a blob that a Checkpoint references, and two Evidence records of one View and render context, each with its screenshot
    Given the store also holds a Handoff manifest and a screenshot that no Evidence record references
    When an operator runs `uiux artifacts gc` on it
    Then the command exits with status 0 and prints the `sha256:` identity of each deleted blob, then their count and total bytes
    Then the older Evidence record of that View and render context, its screenshot, the Handoff manifest and the unreferenced screenshot are gone
    Then the submitted Evidence record, the Checkpoint's blob, the latest Evidence record of that View and render context and their screenshots remain
    Then no Review thread or Checkpoint file has changed
