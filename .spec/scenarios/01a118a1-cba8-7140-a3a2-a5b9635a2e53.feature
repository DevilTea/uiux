Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c6 d2, R2 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815.
  # Test: code@a021f9e `tests/review-resolution-and-hints.test.ts#L138` "declines a ready-for-review submission without accepting it, and keeps the backward-compatible verified default". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-resolution-and-hints.test.ts#L138
  # Test: code@a021f9e `tests/reviews-browser.test.ts#L139` "renders one chronological typed timeline with the declined submission marked Not accepted". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/reviews-browser.test.ts#L139
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cba8-7370-a649-f6a76818feea
  @spec:demonstrates:01a11544-566b-7472-8e4d-b20f5e348222
  @spec:demonstrates:01a11544-5772-750b-9ab3-adcc04d755a9
  Scenario: Closing a ready thread as won't-fix leaves its submission not accepted
    Given a thread ready for review with one submission
    When a human Reviewer resolves it as won't-fix
    Then the thread is resolved without accepting the submission
    Then its timeline marks that submission as not accepted
