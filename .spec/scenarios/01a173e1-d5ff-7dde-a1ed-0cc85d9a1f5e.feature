Feature: Reference integrity and destructive changes
  # Source: https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19180530.
  # Test: code@9910a73 `tests/reference-impact-ack.test.ts#L494` "lists every Decision of the View, whatever its status, and deletes only once acknowledged". https://github.com/DevilTea/uiux/blob/9910a73d2717b8efbe0d8793922707e5fc665bc6/tests/reference-impact-ack.test.ts#L494
  # Status: built as of 9910a73.
  @spec:id:01a173e1-d5ff-7ffb-85e0-85a1700cd920
  @spec:demonstrates:01a172ce-280b-7cec-9ca5-ec189b313ebe
  @spec:demonstrates:01a172ce-bdef-7cf6-bf8c-770dc9dd5e34
  Scenario: Deleting a View lists its Decisions
    Given a View with a pending, a deferred and a decided Decision and nothing else that refers to it
    When an Agent calls `delete_view` without `acknowledgeImpact`
    Then the result is `impact_acknowledgement_required` and lists the three Decisions
    Then the View still exists
