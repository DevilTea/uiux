Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c19 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18561501; #7 c2 d5 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18673968; #7 c9 d4 table https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Test: code@a021f9e `tests/transport-authoring.test.ts#L892` "creates an open review thread, appends messages, re-anchors, submits ready, and resolves with human actor". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/transport-authoring.test.ts#L892
  # Test: code@a021f9e `tests/review-submission.test.ts#L14` "names the anchored View at its current revision and references formal captures". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-submission.test.ts#L14
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cac7-73e4-b219-2a9175ebcafb
  @spec:demonstrates:01a11544-5459-73a9-89d2-dd4d3ed42da3
  @spec:demonstrates:01a11544-54f5-76e0-b5ee-b137d387f08e
  Scenario: An Agent marks its fix ready for review
    Given an Agent member changed a View in answer to an open thread on it
    Given the Agent captured complete formal Evidence of that View at its current revision
    When the Agent marks the thread ready for review, naming the View at that revision and citing the Evidence
    Then the thread is ready for review
    Then it has a new immutable submission that names the View at that revision
