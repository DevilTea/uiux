Feature: Reference integrity and destructive changes
  # Source: #241 owner rulings 2026-10-25 (#75) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19177134.
  # Test: code@257b3c5 `tests/reference-impact-ack.test.ts#L159` "refuses to write over MCP and HTTP with the same impact, and writes nothing". https://github.com/DevilTea/uiux/blob/257b3c528935a5d6e2d09f01cc938db160381b8a/tests/reference-impact-ack.test.ts#L159
  # Status: built as of 257b3c5.
  @spec:id:01a172e2-653d-7818-b18d-2efcf62b4b3e
  @spec:demonstrates:01a172ce-2b4d-70dc-ab08-bd22c71fd1c7
  @spec:demonstrates:01a172ce-bdef-7cf6-bf8c-770dc9dd5e34
  Scenario: Removing a Variant that a Review thread names writes nothing until the impact is acknowledged
    Given a View with Variants `dark` and `compact` and a Review thread that names `dark`
    When an Agent calls `update_view_structure` with Variants that lack `dark` and no `acknowledgeImpact`
    Then the result is `impact_acknowledgement_required` and lists the thread
    Then the View keeps its Variants
