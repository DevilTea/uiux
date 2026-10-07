Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #7 c10 d11, T13, T14 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772501.
  # Test: code@a021f9e `tests/review-v3-browser.test.ts#L314` "groups the bubble\". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-v3-browser.test.ts#L314
  # Test: code@a021f9e `tests/review-v3-inbox.test.ts#L64` "narrows Resolved to verified and answered, adds a Dismissed filter, and hides both by default". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-v3-inbox.test.ts#L64
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d584-7aea-8fcb-0a0016664378
  @spec:demonstrates:01a11544-5727-7d41-b732-3108b15a8ec1
  @spec:demonstrates:01a11544-5dd6-78e1-a187-334dcd6d93f5
  @spec:demonstrates:01a116f0-8dfb-7430-b056-c9cf497d022f
  Scenario: A dismissed thread moves to the Dismissed tab and off the canvas
    Given an open thread with a pin on its View's canvas
    When a Reviewer resolves it as no longer relevant from the Dismiss group of the Resolve menu
    Then the inbox lists it under Dismissed and not under Resolved
    Then its pin is not drawn, even while the canvas shows resolved threads
