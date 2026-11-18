Feature: Content-addressed artifact store
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R3: the roots of artifact cleanup (Evidence a Review submission references, Checkpoint blobs, the latest Evidence record per View and render context; Handoff blobs are not roots) and the explicit `artifacts gc` command https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner confirmations A2, the output https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #58 https://github.com/DevilTea/uiux/issues/58; owner decisions for #252 (2026-10-18) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19019221.
  # Test: code@9e7126e `tests/artifacts-gc.test.ts#L216` "deletes the unreachable blobs, each after the doomed blobs that reference it, and keeps every root kind and what it reaches". https://github.com/DevilTea/uiux/blob/9e7126ebbbe528f27adfda2dc6312297aa172777/tests/artifacts-gc.test.ts#L216
  # Test: code@9e7126e `tests/artifacts-gc.test.ts#L237` "keeps the Evidence that names the View's current revision, not the newest blob, and every record of a group whose order cannot be decided". https://github.com/DevilTea/uiux/blob/9e7126ebbbe528f27adfda2dc6312297aa172777/tests/artifacts-gc.test.ts#L237
  # Test: code@9e7126e `tests/artifacts-gc.test.ts#L277` "reads no version history: a blob only a leftover Checkpoint or host version names is collectable, and an unreadable history file refuses nothing". https://github.com/DevilTea/uiux/blob/9e7126ebbbe528f27adfda2dc6312297aa172777/tests/artifacts-gc.test.ts#L277
  # Test: code@9e7126e `tests/artifacts-gc.test.ts#L293` "keeps every sha256 identity found anywhere in a kept JSON blob that is not a valid Evidence record, recursively". https://github.com/DevilTea/uiux/blob/9e7126ebbbe528f27adfda2dc6312297aa172777/tests/artifacts-gc.test.ts#L293
  # Test: code@9e7126e `tests/artifacts-gc.test.ts#L491` "runs through the uiux binary, which lists it in help and refuses invalid usage with status 2" (the deleting run through `bin/uiux.mjs`). https://github.com/DevilTea/uiux/blob/9e7126ebbbe528f27adfda2dc6312297aa172777/tests/artifacts-gc.test.ts#L491
  # Status: built as of 9e7126e: [#491 P1](https://github.com/DevilTea/uiux/discussions/491#discussioncomment-19699447) removes the Checkpoint root and the version timeline; the latest Evidence is the record naming the View's current revision, and a group with none keeps every record.
  # Note: "Latest" is the Evidence record naming the View's current revision, and a group with none keeps every record ([#491 P1](https://github.com/DevilTea/uiux/discussions/491#discussioncomment-19699447) retires the version timeline of the owner decisions for #252 (2026-10-18) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19019221); in the test the newest record names the View's current revision and every blob shares one modification time, as the artifact store Feature's Notes record.
  @spec:id:01a14f79-f6a7-77cd-ba1f-a392074e4957
  @spec:demonstrates:01a115cd-c208-7a92-9582-69966f36e7fe
  @spec:demonstrates:01a115cd-c23e-7143-bd1e-7ffd9fcaa6f2
  @spec:demonstrates:01a14e30-30de-70c3-888f-63e8982353d7
  @spec:demonstrates:01a14e30-31c0-7289-a944-74af9556eabf
  Scenario: Artifact cleanup deletes only the blobs that no root reaches
    Given a Workspace whose artifact store holds an Evidence record that a Review submission references, and two Evidence records of one View and render context, each with its screenshot
    Given the store also holds a Handoff manifest and a screenshot that no Evidence record references
    When an operator runs `uiux artifacts gc` on it
    Then the command exits with status 0 and prints the `sha256:` identity of each deleted blob, then their count and total bytes
    Then the older Evidence record of that View and render context, its screenshot, the Handoff manifest and the unreferenced screenshot are gone
    Then the submitted Evidence record, the latest Evidence record of that View and render context and their screenshots remain
    Then no Review thread has changed
