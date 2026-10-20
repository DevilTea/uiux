Feature: Content-addressed artifact store
  # Source: Discussion #241 (Part 18), R3: the roots of artifact cleanup https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner decisions for #252 (2026-10-18) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19019221: decision 2, host history versions and the open autosave are roots; issue #253 https://github.com/DevilTea/uiux/issues/253.
  # Test: code@884a5d1 `tests/artifacts-gc.test.ts#L334` "keeps every blob a host history version or the open autosave references, though no Checkpoint does any more". https://github.com/DevilTea/uiux/blob/884a5d1c56b25a2fe67a3312a35ca5e1e54b7980/tests/artifacts-gc.test.ts#L334
  # Status: built as of 884a5d1.
  # Note: The test writes the host version under a temporary `UIUX_HOME` without copying its blob into host history, as a version that a build before issue #253 recorded on a Checkpoint base does; it also names a blob from the open autosave.
  @spec:id:01a14fa2-d1cd-72da-acec-690b66d757c3
  @spec:demonstrates:01a14e30-31c0-7289-a944-74af9556eabf
  Scenario: Artifact cleanup keeps a blob that this host's history references after its Checkpoint is deleted
    Given a Workspace whose artifact store holds a View file blob that a Checkpoint references and a screenshot that nothing references
    Given this host's history of the Workspace holds a version that names the same View file blob, which the host history does not copy
    Given the Checkpoint file is deleted
    When an operator runs `uiux artifacts gc` on it
    Then the command exits with status 0 and deletes only the unreferenced screenshot
    Then the View file blob that the host version names is still in the store
