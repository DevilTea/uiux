Feature: Review messages and retraction
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #7 c10 d8, T12 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772501.
  # Test: code@a021f9e `tests/review-v3-browser.test.ts#L214` "deletes an eligible thread after an inline confirm that starts on Cancel, then moves focus and announces it". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-v3-browser.test.ts#L214
  # Test: code@a021f9e `tests/review-v3-browser.test.ts#L277` "hides Delete once anyone engaged, and on someone else\". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-v3-browser.test.ts#L277
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d6c7-701d-b126-873ad4245a92
  @spec:demonstrates:01a11544-5af4-71eb-b8e4-917743937508
  @spec:demonstrates:01a11544-5b1b-7dcb-bcea-e36f4ffa3b2a
  Scenario: The Workbench confirms deleting a comment inline
    Given a Reviewer's own new thread that nobody has engaged with
    When the Reviewer chooses Delete comment
    Then an inline confirmation row appears with focus on Cancel
    Then no browser dialog is shown
