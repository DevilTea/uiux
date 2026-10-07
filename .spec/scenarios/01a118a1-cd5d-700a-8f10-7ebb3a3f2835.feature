Feature: Review messages and retraction
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c10 d2: E1-E6, T3 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772501; #1 c179 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18772502.
  # Test: code@a021f9e `tests/review-retract.test.ts#L105` "refuses with review.retract_engaged and the matching reason once anyone engaged". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-retract.test.ts#L105
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cd5d-7f72-9766-9371d29a3cf7
  @spec:demonstrates:01a11544-59df-7822-9aba-ff39da0d826b
  @spec:demonstrates:01a11544-6cde-7e91-8aca-f88804c7a05c
  Scenario: Retracting a thread that someone answered is refused
    Given a Reviewer opened a thread
    Given another member replied to it
    When the author retracts the thread
    Then the retraction is refused with `review.retract_engaged` and the reason `messages`
    Then the thread is unchanged
