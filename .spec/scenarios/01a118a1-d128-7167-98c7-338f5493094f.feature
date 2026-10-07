Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d1; d9 `member set` https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@a021f9e `tests/access-store.test.ts#L122` "caps agents at Editor, keeps kind immutable and protects the last human Owner". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-store.test.ts#L122
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d128-7e3e-bbe9-ffb29b33b7dc
  @spec:demonstrates:01a11485-eae3-7080-8f02-da27fc260e09
  @spec:demonstrates:01a114ec-ea2d-7f54-97d1-f981d48795fb
  Scenario: The last human Owner cannot be removed or demoted
    Given a roster with exactly one human Owner
    When that Owner is demoted to Editor
    Then the change is refused with `auth.last_owner`
    Then the roster is unchanged
