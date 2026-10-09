Feature: Version history
  # Source: Discussion #122 (Part 11) d4, R26 (owner pre-answer O3) https://github.com/DevilTea/uiux/discussions/122; "What `.spec/` records after acceptance" key Scenarios https://github.com/DevilTea/uiux/discussions/122; owner acceptance https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263. Restated as permission keys by Discussion #140 (Part 15), decision 1, A: `checkpoints.create`; Interactions 2 https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: partly built as of 41330c7: the Checkpoint is created without a lease, but `checkpoints.create` is granted by the Reviewer role, not a key; see the Implementation gaps entry of 01a11485-fa21-7b77-8ae5-1d7d0618e8a3 in its owner.
  # Test: code@41330c7 `tests/history-checkpoints.test.ts#L167` "writes a named record with the member as actor, holding no lease and changing no canonical file (Scenario 01a11a5e-90a5)". https://github.com/DevilTea/uiux/blob/41330c7736ba6a62859ee612ca7fbde133f00d89/tests/history-checkpoints.test.ts#L167
  # Note: Discussion #139 (Part 14) moved the checkpoint directory, so the step names no path. Discussion #140 restates the precondition as `checkpoints.create` (issue #142).
  @spec:id:01a11a5e-90a5-70f3-912e-e9e6e9b0eee9
  @spec:demonstrates:01a11485-fa21-7b77-8ae5-1d7d0618e8a3
  @spec:demonstrates:01a11a5e-096a-761e-a65a-6fd66e7e0b12
  @spec:demonstrates:01a11a5e-0a0c-7d65-8d09-9a71a730ec61
  @spec:demonstrates:01a11a5e-1e0e-7539-b925-c54dcb1afb55
  Scenario: A member holding `checkpoints.create` creates a Checkpoint without a lease
    Given a human member holding `checkpoints.create` and no edit lease
    When the member creates a Checkpoint named "v1 layout approved" with a note
    Then a Checkpoint record with that name, the note and the member as its actor is written to the Workspace's Checkpoint directory
    Then no canonical file changes
