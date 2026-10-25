Feature: Reference integrity and destructive changes
  # Source: #241 owner rulings 2026-10-25 (#75) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19177134.
  # Test: code@257b3c5 `tests/reference-impact-ack.test.ts#L300` "deletes once acknowledged: the View goes, nothing else is touched, and the references report as dangling". https://github.com/DevilTea/uiux/blob/257b3c528935a5d6e2d09f01cc938db160381b8a/tests/reference-impact-ack.test.ts#L300
  # Status: built as of 257b3c5.
  @spec:id:01a172e2-61c2-7e64-b894-0fd94cb0bb28
  @spec:demonstrates:01a1144e-50ef-7219-ae87-bb012dc85f12
  @spec:demonstrates:01a172ce-280b-7cec-9ca5-ec189b313ebe
  @spec:demonstrates:01a172ce-bdef-7cf6-bf8c-770dc9dd5e34
  @spec:demonstrates:01a172ce-ebcc-7a79-8103-ff5339409948
  Scenario: An acknowledged delete removes only the View
    Given a View with a Review thread anchored in it and a UX Flow step that targets it
    When an Agent calls `delete_view` with `acknowledgeImpact` true
    Then the result is `deleted` with the change `{ path: "", op: "remove" }`
    Then the thread and the Flow step are unchanged and report a missing View
