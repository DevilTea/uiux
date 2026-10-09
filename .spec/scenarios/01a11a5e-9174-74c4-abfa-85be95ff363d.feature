Feature: Version history
  # Source: Discussion #122 (Part 11) d10 rule 5 https://github.com/DevilTea/uiux/discussions/122; "What `.spec/` records after acceptance" key Scenarios https://github.com/DevilTea/uiux/discussions/122; owner acceptance https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263.
  # Status: built as of 6ee4a5c.
  # Test: code@6ee4a5c `tests/history-restore.test.ts#L338` "writes nothing and lists the thread whose anchor would become invalid, then writes once acknowledged". https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/tests/history-restore.test.ts#L338
  # Test: code@6ee4a5c `tests/history-restore.test.ts#L571` "takes the Clause's input and answers what HTTP answers". https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/tests/history-restore.test.ts#L571
  @spec:id:01a11a5e-9174-7006-b506-038e979982b8
  @spec:demonstrates:01a11a5e-16f7-7229-8d17-587490168f1f
  @spec:demonstrates:01a11a5e-174b-7e74-b232-5ec76601fbed
  @spec:demonstrates:01a11a5e-2768-76ad-b02a-e15f50f91268
  Scenario: A restore with impact needs acknowledgement
    Given a View with a Review thread anchored to a Widget that an earlier version of the View lacks
    When an Editor restores the View to that version without acknowledging impact
    Then nothing is written
    Then the result is `impact_acknowledgement_required` and lists the thread whose anchor would become invalid
