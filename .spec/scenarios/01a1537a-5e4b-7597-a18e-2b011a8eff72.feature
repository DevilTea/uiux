Feature: Agent authoring over MCP
  # Source: Discussion #241 (Part 18), proposal and owner acceptance "View rename (#56)", 2026-10-19 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19036740; issue #56 https://github.com/DevilTea/uiux/issues/56.
  # Status: not built as of dff1553; see the Implementation gaps entry of 01a15379-d8f7-7c0c-9b9a-05c07c64cc85 in its owner.
  # Note: No test exists yet.
  @spec:id:01a1537a-5e4b-7f25-a271-f8229a3803bc
  @spec:demonstrates:01a1144e-4fa5-7ff4-aeb0-1278a85f188b
  @spec:demonstrates:01a115cd-c5a5-757a-b049-b5138fe75920
  @spec:demonstrates:01a15379-d8f7-7c0c-9b9a-05c07c64cc85
  Scenario: Renaming a View keeps its formal Evidence fresh
    Given a View with a formal capture of its current IR and Variants
    When an Agent changes the View's name and `feature` tag with `update_view_metadata`
    Then the View keeps its identity, IR and Variants
    Then the formal capture stays fresh
