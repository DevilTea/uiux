Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #7 c9 d6, O3 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095; #1 c178 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18772098.
  # Test: code@a021f9e `tests/review-scope-and-edit.test.ts#L170` "refuses a display hint and promotion on a Workspace thread (O3)". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-scope-and-edit.test.ts#L170
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d536-75fb-b2fc-dce649bf32fc
  @spec:demonstrates:01a11544-5fb8-7547-b41a-ded1e2a23a8a
  @spec:demonstrates:01a11544-6c84-788f-82a2-fecc7c66aeb6
  Scenario: A Workspace thread cannot be promoted
    Given a thread anchored to the Workspace
    When a Reviewer promotes it to a Decision
    Then the promotion is refused with `review.decision_target_unavailable`
