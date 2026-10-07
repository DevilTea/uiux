Feature: Review messages and retraction
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #7 c9 d12, O2 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Test: code@a021f9e `tests/review-schema-v3.test.ts#L199` "freezes a message at a later submission or resolution, and reopening never unfreezes it (O2)". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-schema-v3.test.ts#L199
  # Test: code@a021f9e `tests/review-scope-and-edit.test.ts#L265` "refuses non-authors, legacy messages, frozen messages, empty and no-op edits with the decided codes". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-scope-and-edit.test.ts#L265
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d676-7df8-90e2-f0850e499f3a
  @spec:demonstrates:01a115cd-2e6a-7911-9a3a-ef4a00e1339d
  Scenario: Reopening a thread never unfreezes a message
    Given a message frozen by a later submission
    When the thread is reopened
    When the author edits the message
    Then the edit is refused
