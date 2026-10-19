Feature: Agent authoring over MCP
  # Source: Discussion #241 (Part 18), proposal and owner acceptance "View rename (#56)", 2026-10-19 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19036740; issue #56 https://github.com/DevilTea/uiux/issues/56.
  # Status: not built as of dff1553; see the Implementation gaps entry of 01a15379-d8f7-7c0c-9b9a-05c07c64cc85 in its owner.
  # Note: No test exists yet.
  @spec:id:01a1537a-61db-7608-933b-6500bb64e087
  @spec:demonstrates:01a1144e-51d6-7b17-8ef7-986d00f937e2
  @spec:demonstrates:01a15379-d8f7-7c0c-9b9a-05c07c64cc85
  Scenario: A null feature clears the View's tag
    Given a View tagged with the feature `checkout`
    When an Agent calls `update_view_metadata` with `feature` set to `null` and no `name`
    Then the View has no `feature` tag and keeps its name
    Then the View appears ungrouped
