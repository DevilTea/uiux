Feature: A Flow trace is stale once its Flow changed
  # Source: Discussion #241 owner confirmations on PR #243 (B1), the change domain `flow` https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #88.
  # Test: code@82de28b `tests/evidence-staleness.test.ts#L358` "is stale once its Flow changed or no longer exists, or the trace records no Flow". https://github.com/DevilTea/uiux/blob/82de28b/tests/evidence-staleness.test.ts#L358
  # Test: code@82de28b `tests/handoff-closure.test.ts#L1979` "leaves out a trace once its Flow changed". https://github.com/DevilTea/uiux/blob/82de28b/tests/handoff-closure.test.ts#L1979
  # Status: Partly built as of 82de28b: the Clause 01a14e30-2e43-75a7-aca8-c8df28915f4e it demonstrates is Partly built (see the Implementation gaps of its Contract); the Flow trace behavior this Scenario shows is built.
  @spec:id:01a177b3-8eff-74a2-8011-80a1f2f24bf3
  @spec:demonstrates:01a14e30-2e43-75a7-aca8-c8df28915f4e
  Scenario: A Flow trace is stale once its Flow changed
    Given a flow_trace record that recorded the revision of its Flow
    When the Flow changes
    Then the trace is stale and a Handoff export leaves it out
