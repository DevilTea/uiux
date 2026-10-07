Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c9 owner requirement: View-level comments use the existing RootShell anchor https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095; #1 c178 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18772098.
  # Test: code@a021f9e `tests/review-feedback-browser.test.ts#L185` "opens the composer without a Widget and anchors the thread to the RootShell". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-feedback-browser.test.ts#L185
  # Status: built as of a021f9e.
  @spec:id:01a118a1-c8c4-797e-94c6-52ce0c191c5b
  @spec:demonstrates:01a11544-5170-7aec-8d4b-56b8faacfca2
  Scenario: A comment on the whole View is anchored to its RootShell
    Given a View is open in the Workbench
    When the Reviewer comments on the View as a whole without choosing a Widget
    Then the new thread is anchored to that View's RootShell Widget
