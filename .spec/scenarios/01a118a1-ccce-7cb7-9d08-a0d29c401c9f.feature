Feature: Review messages and retraction
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c9 d12 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095; #1 c178 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18772098.
  # Test: code@a021f9e `tests/review-scope-and-edit.test.ts#L265` "refuses non-authors, legacy messages, frozen messages, empty and no-op edits with the decided codes". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-scope-and-edit.test.ts#L265
  # Test: code@a021f9e `tests/review-schema-v3.test.ts#L199` "freezes a message at a later submission or resolution, and reopening never unfreezes it (O2)". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-schema-v3.test.ts#L199
  # Status: built as of a021f9e.
  @spec:id:01a118a1-ccce-75dc-af5d-a76b8509fdd2
  @spec:demonstrates:01a11544-57e2-701c-946f-3fe75f5294ba
  Scenario: A message cannot be edited after a later submission
    Given an Agent wrote a message on a thread
    Given the thread was then marked ready for review
    When the Agent edits that message
    Then the edit is refused and the message keeps its text
