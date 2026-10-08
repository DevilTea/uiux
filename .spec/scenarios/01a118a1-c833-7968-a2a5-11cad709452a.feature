Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c3 10a: at least status, View, anchor validity, Variant scope and change or Evidence domain https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18674068.
  # Test: code@a021f9e `tests/review-inbox.test.ts#L138` "marks a thread updated since the member last looked, unless the member moved it last". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-inbox.test.ts#L138
  # Status: built as of a021f9e.
  # Note: The cited test checks the classification behind the changed-since-last-looked filter (`isUnreadThread` in `app/utils/review-inbox.ts`); no test at a021f9e narrows the inbox list with that filter. The code also treats a thread whose latest change is the member's own as unchanged; no Rule states that, so this Scenario does not assert it.
  @spec:id:01a118a1-c833-7b6e-b3b5-e115152dd913
  @spec:demonstrates:01a116f0-8e3e-7b1f-a12a-79fdcaccbf62
  Scenario: The inbox narrows to threads changed since the Reviewer last looked
    Given a Reviewer last saw one thread before another member replied to it
    Given the Reviewer has seen a second thread since its latest change
    When the Reviewer narrows the inbox to threads changed since they last looked
    Then the first thread is listed
    Then the second thread is not
