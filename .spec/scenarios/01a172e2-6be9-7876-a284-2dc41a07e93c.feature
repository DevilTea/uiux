Feature: Reference integrity and destructive changes
  # Source: #241 owner rulings 2026-10-25 (#75) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19177134.
  # Test: code@257b3c5 `tests/reference-impact-ack.test.ts#L230` "refuses to write over MCP and HTTP with the same impact, and writes nothing". https://github.com/DevilTea/uiux/blob/257b3c528935a5d6e2d09f01cc938db160381b8a/tests/reference-impact-ack.test.ts#L230
  # Status: built as of 257b3c5.
  @spec:id:01a172e2-6be9-7d34-96bd-1af18f77ea3b
  @spec:demonstrates:01a172ce-2e97-7d83-b175-f0d15f846768
  @spec:demonstrates:01a172ce-bdef-7cf6-bf8c-770dc9dd5e34
  Scenario: Removing a viewport key over MCP needs an acknowledged impact
    Given a Review thread whose render context names the viewport `mobile`
    When an Agent calls `update_workspace_settings` with viewports that lack `mobile` and no `acknowledgeImpact`
    Then the result is `impact_acknowledgement_required` and lists the viewport key with the thread
    Then the Workspace settings are unchanged
