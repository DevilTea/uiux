Feature: Reference integrity and destructive changes
  # Source: #241 owner rulings 2026-10-25 (#75) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19177134.
  # Test: code@257b3c5 `tests/reference-impact-ack.test.ts#L276` "refuses to delete over MCP and HTTP with the same impact, and deletes nothing". https://github.com/DevilTea/uiux/blob/257b3c528935a5d6e2d09f01cc938db160381b8a/tests/reference-impact-ack.test.ts#L276
  # Status: built as of 257b3c5.
  @spec:id:01a172e2-5e66-7b32-9176-9e4925f90d8c
  @spec:demonstrates:01a172ce-280b-7cec-9ca5-ec189b313ebe
  @spec:demonstrates:01a172ce-bdef-7cf6-bf8c-770dc9dd5e34
  @spec:demonstrates:01a172ce-ebcc-7a79-8103-ff5339409948
  Scenario: Deleting a View with references writes nothing until the impact is acknowledged
    Given a View with a Review thread anchored in it and a UX Flow step that targets it
    When an Agent calls `delete_view` without `acknowledgeImpact`
    Then the result is `impact_acknowledgement_required` and lists the thread and the Flow step
    Then the View still exists
