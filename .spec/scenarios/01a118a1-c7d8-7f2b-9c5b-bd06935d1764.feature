Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c3 10a https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18674068; #7 c10 d11 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772501.
  # Test: code@a021f9e `tests/reviews-browser.test.ts#L112` "orders the default queue as Part 7 10a: resolved hidden, ready before open, latest activity first". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/reviews-browser.test.ts#L112
  # Test: code@a021f9e `tests/review-inbox.test.ts#L63` "hides resolved by default, puts ready before open, and sorts each group by latest activity descending". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-inbox.test.ts#L63
  # Test: code@a021f9e `tests/review-inbox.test.ts#L69` "reaches resolved threads only through an explicit filter, as the last group". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-inbox.test.ts#L69
  # Status: built as of a021f9e.
  @spec:id:01a118a1-c7d8-7d73-9c30-f45340617bfd
  @spec:demonstrates:01a116f0-8d33-7c2a-ba50-fc177e9deda1
  @spec:demonstrates:01a116f0-8db9-75c3-a642-652570053138
  Scenario: The inbox lists threads ready for review first and hides resolved ones
    Given a Workspace with a resolved thread, an open thread and a thread ready for review
    When a Reviewer opens the Reviews inbox
    Then the thread ready for review is listed before the open thread
    Then the resolved thread is listed only once the Reviewer chooses its tab or filter
