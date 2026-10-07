Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c6 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815; #7 c2 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18673968.
  # Test: code@a021f9e `tests/review-resolution-and-hints.test.ts#L138` "declines a ready-for-review submission without accepting it, and keeps the backward-compatible verified default". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-resolution-and-hints.test.ts#L138
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cb58-7851-ab6d-0516317ef69a
  @spec:demonstrates:01a11544-5621-71c6-b5b9-ad1b1ef809ab
  @spec:demonstrates:01a11544-6b86-7529-8440-f37c43558427
  Scenario: Resolving a ready thread without a resolution verifies it
    Given a thread ready for review with one submission
    When a human Reviewer resolves it in the Workbench without naming a resolution
    Then the thread is resolved as verified
    Then the resolution names that submission
