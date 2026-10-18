Feature: Content-addressed artifact store
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R3: the roots of artifact cleanup and the explicit `artifacts gc` command with its `--dry-run` mode https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner confirmations A2, the output https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #58 https://github.com/DevilTea/uiux/issues/58; owner decisions for #252 (2026-10-18) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19019221.
  # Test: code@884a5d1 `tests/artifacts-gc.test.ts#L244` "with --dry-run lists only the unreachable blobs, then their count and total bytes, and deletes nothing". https://github.com/DevilTea/uiux/blob/884a5d1c56b25a2fe67a3312a35ca5e1e54b7980/tests/artifacts-gc.test.ts#L244
  # Test: code@884a5d1 `tests/artifacts-gc.test.ts#L518` "runs through the uiux binary, which lists it in help and refuses invalid usage with status 2" (the dry run through `bin/uiux.mjs`). https://github.com/DevilTea/uiux/blob/884a5d1c56b25a2fe67a3312a35ca5e1e54b7980/tests/artifacts-gc.test.ts#L518
  # Status: built as of 4fc05a7; the roots as amended, as of 884a5d1.
  @spec:id:01a14f79-cd79-7dcc-9e4e-faa7d3cd0ba3
  @spec:demonstrates:01a14e30-30de-70c3-888f-63e8982353d7
  @spec:demonstrates:01a14e30-31c0-7289-a944-74af9556eabf
  Scenario: A dry run of artifact cleanup lists the blobs no root reaches and deletes nothing
    Given a Workspace whose artifact store holds an Evidence record that a Review submission references, a blob that a Checkpoint references, and two Evidence records of one View and render context, each with its screenshot
    Given the store also holds a Handoff manifest and a screenshot that no Evidence record references
    When an operator runs `uiux artifacts gc --dry-run` on it
    Then the command exits with status 0
    Then it prints the `sha256:` identities of the older Evidence record of that View and render context, its screenshot, the Handoff manifest and the unreferenced screenshot, then their count and total bytes
    Then every blob is still in the store
