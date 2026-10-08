Feature: Review messages and retraction
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c9 d10, d15, R11 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095; #1 c178 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18772098.
  # Test: code@a021f9e `tests/review-scope-and-edit.test.ts#L232` "lets the author edit over HTTP, keeps every version append-only, stamps actor and time, and counts as activity". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-scope-and-edit.test.ts#L232
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cc85-70e7-b0d2-f55fd4acc0fe
  @spec:demonstrates:01a11544-5855-75ad-ba0c-4132b19973ec
  @spec:demonstrates:01a11544-587e-74a3-96b8-cf85473bed0f
  Scenario: An author edits their message before any submission
    Given a Reviewer wrote a message on an open thread
    When the Reviewer replaces that message's text
    Then the message shows the new text at its original time and position
    Then the replaced text is kept as an earlier version with the edit's stamped actor and time
