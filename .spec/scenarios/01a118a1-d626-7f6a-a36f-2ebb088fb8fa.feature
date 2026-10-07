Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #7 c9 d3, R4 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095; #7 c1 d4 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18673686; #7 body: item 4 https://github.com/DevilTea/uiux/discussions/7.
  # Test: code@a021f9e `tests/review-scope-and-edit.test.ts#L133` "re-anchors between the arms in both directions with the hint rules and full history". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-scope-and-edit.test.ts#L133
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d626-762d-b680-24eda95a62ba
  @spec:demonstrates:01a11544-52e9-7559-b671-44d0bdf68879
  @spec:demonstrates:01a11544-530d-7048-96d6-ab6c2d0e92ab
  Scenario: Re-anchoring records the previous anchor
    Given a thread anchored to a Widget
    When a Reviewer re-anchors it to the Workspace
    Then it becomes a Workspace thread
    Then its history gains an event with the previous Widget anchor and the new Workspace anchor
