Feature: Workspace schema versioning
  # Source: Discussion #231 (Part 17, one current format) https://github.com/DevilTea/uiux/discussions/231; owner acceptance 2026-10-17 https://github.com/DevilTea/uiux/discussions/231#discussioncomment-18992111: Changes 1.2, 1.3 and 3.1, the `.spec/` units New table, owner question Q4.
  # Status: built as of 483b6ab.
  # Test: code@1c86869 `tests/workspace-selection.test.ts#L249` "uiux dev, with --workspace and by discovery from inside the old directory". https://github.com/DevilTea/uiux/blob/1c86869155a214252d7be32951d3a07fa6d52421/tests/workspace-selection.test.ts#L249
  # Test: code@1c86869 `tests/workspace-selection.test.ts#L222` "every roster command, and both sides of access copy". https://github.com/DevilTea/uiux/blob/1c86869155a214252d7be32951d3a07fa6d52421/tests/workspace-selection.test.ts#L222
  # Test: code@1c86869 `tests/workspace-selection.test.ts#L267` "the packaged server". https://github.com/DevilTea/uiux/blob/1c86869155a214252d7be32951d3a07fa6d52421/tests/workspace-selection.test.ts#L267
  # Test: code@1c86869 `tests/workspace-selection.test.ts#L114` "refuses a manifest at any other schemaVersion, older or newer, naming it, the current one and uiux init". https://github.com/DevilTea/uiux/blob/1c86869155a214252d7be32951d3a07fa6d52421/tests/workspace-selection.test.ts#L114
  @spec:id:01a14917-8bed-76d5-93ea-7646b9f0654b
  @spec:demonstrates:01a1144e-4fe2-7bbe-82f2-e846e43def27
  @spec:demonstrates:01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9
  @spec:demonstrates:01a14928-275b-74d5-ad43-c82932e39cb3
  Scenario: A Workspace at an older schemaVersion is refused at startup
    Given a Workspace whose manifest has `schemaVersion` 5
    When an operator runs `uiux dev --workspace` on it
    Then the command exits with status 2 and its message names `schemaVersion` 5 and the version this UIUX reads
    Then the message suggests `uiux init` in a new directory and does not name `uiux migrate`
    Then no file of the Workspace or of `$UIUX_HOME` has changed
