Feature: An Agent validates a Flow and gets its structural and reference diagnostics
  # Source: Discussion #241 owner rulings 2026-10-25 (#88 Flows on the server) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19177134, items 4-6.
  # Test: code@33bca1f `tests/flow-evidence.test.ts#L131` "reports diagnostics identically through the application, HTTP helpers and MCP". https://github.com/DevilTea/uiux/blob/33bca1f/tests/flow-evidence.test.ts#L131
  # Status: built as of 33bca1f.
  @spec:id:01a172d3-ef1a-7d17-a0d7-b97f96606ce3
  @spec:demonstrates:01a11544-629c-7dbf-8e41-36c8e37537b3
  @spec:demonstrates:01a172cc-de18-79ea-a611-c8ea5a34e250
  Scenario: An Agent validates a Flow and gets its structural and reference diagnostics
    Given a UX Flow whose step targets a View that does not exist
    When an Agent validates the Flow
    Then the result says the Flow is not valid and lists the missing View at the step's reference
    Then validating again over HTTP returns the same result
