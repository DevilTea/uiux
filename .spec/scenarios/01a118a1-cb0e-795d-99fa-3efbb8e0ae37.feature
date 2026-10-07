Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c20 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18561691; #7 c9 d4 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Test: code@a021f9e `tests/review-scope-and-edit.test.ts#L189` "requires the current manifest revision and makes every named View valid and current". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-scope-and-edit.test.ts#L189
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cb0e-7652-9217-db24913f0d37
  @spec:demonstrates:01a11544-558b-7b86-b4c7-76928862c948
  @spec:demonstrates:01a115cd-3769-7376-ba43-a6b867d8cb85
  Scenario: Marking ready with Evidence of an older View revision is refused
    Given an open thread on a View
    Given a formal capture of an earlier revision of that View
    When a member marks the thread ready for review citing that capture
    Then marking ready is refused with `review.formal_evidence_not_current`
    Then the thread stays open without a new submission
