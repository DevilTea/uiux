Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c2 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18673968; #7 c6 d4 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815.
  # Test: code@a021f9e `tests/transport-authoring.test.ts#L892` "creates an open review thread, appends messages, re-anchors, submits ready, and resolves with human actor". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/transport-authoring.test.ts#L892
  # Test: code@a021f9e `tests/review-schema-v2.test.ts#L78` "keeps the evidence gate for verified: ready-for-review, the active submission, and a human". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-schema-v2.test.ts#L78
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cbf4-733f-9be3-5a6d0b9c3f88
  @spec:demonstrates:01a11544-56b5-78ff-bce6-ed5183a13ad2
  @spec:demonstrates:01a11544-56db-73f1-addf-96c97320e8ee
  Scenario: Reopening keeps the history and needs a new submission to verify
    Given a thread resolved as verified
    When a Reviewer reopens it
    Then the thread is open and its earlier submission and lifecycle events are unchanged
    Then it can be resolved as verified again only after a new submission
