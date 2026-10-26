Feature: A Flow trace is stale once its Flow changed
  # Source: Discussion #241 owner confirmations on PR #243 (B1), the change domain `flow` https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #88.
  # Test: code@8c77b6e `tests/evidence-staleness.test.ts#L358` "is stale once its Flow changed or no longer exists, or the trace records no Flow". https://github.com/DevilTea/uiux/blob/8c77b6e/tests/evidence-staleness.test.ts#L358
  # Test: code@8c77b6e `tests/handoff-closure.test.ts#L1978` "leaves out a trace once its Flow changed, and notes the Flow as having only stale traces". https://github.com/DevilTea/uiux/blob/8c77b6e/tests/handoff-closure.test.ts#L1978
  # Status: built as of 8c77b6e.
  @spec:id:01a177b3-8eff-74a2-8011-80a1f2f24bf3
  @spec:demonstrates:01a14e30-2e43-75a7-aca8-c8df28915f4e
  Scenario: A Flow trace is stale once its Flow changed
    Given a flow_trace record that recorded the revision of its Flow
    When the Flow changes
    Then the trace is stale and a Handoff export leaves it out
