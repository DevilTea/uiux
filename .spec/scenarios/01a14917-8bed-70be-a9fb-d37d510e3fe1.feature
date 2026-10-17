Feature: Workspace schema versioning
  # Source: Discussion #231 (Part 17, one current format) https://github.com/DevilTea/uiux/discussions/231; owner acceptance 2026-10-17 https://github.com/DevilTea/uiux/discussions/231#discussioncomment-18992111: Changes 1.2 and 3.1, the `.spec/` units New table, owner question Q4.
  # Status: not built as of 21c5130: a Workspace at `schemaVersion` 5 still starts and needs migration; see the Implementation gaps entries of 01a1144e-4fe2-7bbe-82f2-e846e43def27 and 01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9 in their owners (issue #232).
  # Note: No test exists yet.
  @spec:id:01a14917-8bed-76d5-93ea-7646b9f0654b
  @spec:demonstrates:01a1144e-4fe2-7bbe-82f2-e846e43def27
  @spec:demonstrates:01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9
  Scenario: A Workspace at an older schemaVersion is refused at startup
    Given a Workspace whose manifest has `schemaVersion` 5
    When an operator runs `uiux dev --workspace` on it
    Then the command exits with status 2 and its message names `schemaVersion` 5 and the version this UIUX reads
    Then no file of the Workspace or of `$UIUX_HOME` has changed
