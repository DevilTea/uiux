Feature: Reference integrity and destructive changes
  # Source: #241 owner rulings 2026-10-25 (#75) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19177134.
  # Test: code@257b3c5 `tests/reference-impact-ack.test.ts#L181` "writes once acknowledged, over MCP and HTTP, and leaves what names the Variant untouched". https://github.com/DevilTea/uiux/blob/257b3c528935a5d6e2d09f01cc938db160381b8a/tests/reference-impact-ack.test.ts#L181
  # Status: built as of 257b3c5.
  @spec:id:01a172e2-6894-79ad-8f63-64d2c095fa36
  @spec:demonstrates:01a1144e-50ef-7219-ae87-bb012dc85f12
  @spec:demonstrates:01a172ce-2b4d-70dc-ab08-bd22c71fd1c7
  @spec:demonstrates:01a172ce-bdef-7cf6-bf8c-770dc9dd5e34
  Scenario: An acknowledged Variant removal leaves the thread naming it
    Given a View with Variants `dark` and `compact` and a Review thread that names `dark`
    When an Agent calls `update_view_structure` with Variants that lack `dark` and `acknowledgeImpact` true
    Then the View is written without `dark`
    Then the thread still names `dark`
