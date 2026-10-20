Feature: Version history
  # Source: Discussion #241 (Part 18) owner decisions for #251 and #252 (2026-10-18), decision 2: host history versions are artifact-cleanup roots, and a separate issue makes the history recorder copy the blobs into host history when its base is a Checkpoint https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19019221; issue #253 https://github.com/DevilTea/uiux/issues/253.
  # Test: code@e2bf40e `tests/history-recorder.test.ts#L996` "keeps an autosave on a Checkpoint base comparable and restorable after that Checkpoint is deleted and artifact cleanup runs on another host". https://github.com/DevilTea/uiux/blob/e2bf40e1087ec30aaf43a60a5711b7325ef748a7/tests/history-recorder.test.ts#L996
  # Status: built as of e2bf40e.
  # Note: The test writes the pulled Checkpoint without copying its blobs to this host, as another clone's Checkpoint arrives through Git, and runs `uiux artifacts gc` with a different temporary `UIUX_HOME`, where this host's history is not a root.
  @spec:id:01a158cb-8ac1-733f-b949-16d93f912369
  @spec:demonstrates:01a11a5e-1e65-7deb-a89e-6ad021248fe0
  Scenario: A host version recorded on a Checkpoint stays comparable after that Checkpoint is deleted and another host cleans up artifacts
    Given this host's history of a Workspace has a Checkpoint pulled from another clone as its latest version, holding a View this host never recorded
    Given an Agent's autosave was recorded on this host on top of that Checkpoint
    Given the Checkpoint file is deleted
    Given `uiux artifacts gc` on another host deleted that View's blobs from the artifact store
    When a member on this host compares the autosave with the current files
    Then the comparison succeeds, with that View's file bytes read from this host's history
    Then the View can be restored from the autosave
