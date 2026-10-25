Feature: Another Decision is created from an already promoted thread
  # Source: Owner rulings 2026-10-25 (#86 Decision lifecycle) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19175269.
  # Test: code@bd59929 `tests/decision-lifecycle.test.ts#L317` "creates a second, independent Decision from a promoted thread, and promotion still returns the first". https://github.com/DevilTea/uiux/blob/bd5992961ff64a00a2697e7aa00022be773fe11c/tests/decision-lifecycle.test.ts#L317
  # Test: code@bd59929 `tests/decision-lifecycle.test.ts#L339` "returns the Decision it created for a retry with the same decisionId, before any revision check and writing nothing". https://github.com/DevilTea/uiux/blob/bd5992961ff64a00a2697e7aa00022be773fe11c/tests/decision-lifecycle.test.ts#L339
  # Test: code@bd59929 `tests/decision-lifecycle-browser.test.ts#L147` "creates another Decision from an already promoted thread in the Reviews detail". https://github.com/DevilTea/uiux/blob/bd5992961ff64a00a2697e7aa00022be773fe11c/tests/decision-lifecycle-browser.test.ts#L147
  # Status: built as of bd59929.
  @spec:id:01a17233-fc1c-7b5c-86b6-90408f6e6454
  @spec:demonstrates:01a11544-6084-7f2c-848d-cc4319e66134
  @spec:demonstrates:01a17226-fca4-7a13-b38e-c51ffeb47c44
  Scenario: Another Decision is created from an already promoted thread
    Given a Review thread promoted to a Decision in its View
    When a member holding reviews.promote creates another Decision from the thread with a new decisionId
    When the same call is retried with the same decisionId
    Then the View holds two Decisions from the thread
    Then the retry returns the second Decision and writes nothing
