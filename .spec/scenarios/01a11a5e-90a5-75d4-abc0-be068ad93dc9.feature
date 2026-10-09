Feature: Version history
  # Source: Discussion #122 (Part 11) d4, R26 (owner pre-answer O3) https://github.com/DevilTea/uiux/discussions/122; "What `.spec/` records after acceptance" key Scenarios https://github.com/DevilTea/uiux/discussions/122; owner acceptance https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263. Restated as permission keys by Discussion #140 (Part 15), decision 1, A: `checkpoints.create`; Interactions 2 https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: not built as of cf3b984; see the Implementation gaps entries of 01a11a5e-0a0c-7d65-8d09-9a71a730ec61 and 01a11485-fa21-7b77-8ae5-1d7d0618e8a3 in their owners.
  # Note: No test exists yet; tracked in issue #132. Discussion #139 (Part 14) moved the checkpoint directory, so the step names no path. Discussion #140 restates the precondition as `checkpoints.create` (issue #142).
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
