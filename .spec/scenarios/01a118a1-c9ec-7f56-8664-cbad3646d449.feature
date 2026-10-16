Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c6 d10 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815; #1 c175 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757819.
  # Test: code@a021f9e `tests/reviews-browser.test.ts#L212` "triages from the keyboard: J/K move, E resolves an open thread as answered in one keystroke and moves on". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/reviews-browser.test.ts#L212
  # Test: code@48a04aa `tests/reviews-browser.test.ts#L333` "accepts a ready thread with one-click Resolve as verified, naming its current submission". https://github.com/DevilTea/uiux/blob/48a04aaffc0f1a95f6f9feb3e3739efd3e274e3c/tests/reviews-browser.test.ts#L333
  # Status: built as of a021f9e.
  @spec:id:01a118a1-c9ec-7b31-8e21-75b3a25719c4
  @spec:demonstrates:01a11544-5702-78b6-95ea-c15fe80ad4e3
  Scenario: The one-click Resolve answers an open thread and verifies a ready one
    Given an open thread and a thread ready for review with one submission are in the Reviews inbox
    When the Reviewer uses the one-click Resolve on each of them
    Then the open thread is resolved as answered
    Then the ready thread is resolved as verified, naming its submission
