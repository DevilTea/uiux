Feature: Agent authoring over MCP
  # Source: Discussion #241 (Part 18), proposal and owner acceptance "View rename (#56)", 2026-10-19 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19036740; issue #56 https://github.com/DevilTea/uiux/issues/56.
  # Test: code@931cb3f `tests/view-metadata.test.ts#L230` "clears the feature tag with null and no name (Scenario 01a1537a-61db)". https://github.com/DevilTea/uiux/blob/931cb3f308c37e35410aac914e5e8c7d211b3053/tests/view-metadata.test.ts#L230
  # Test: code@931cb3f `tests/view-metadata.test.ts#L139` "removes the feature tag with null, and the View appears ungrouped (Scenario 01a1537a-61db)". https://github.com/DevilTea/uiux/blob/931cb3f308c37e35410aac914e5e8c7d211b3053/tests/view-metadata.test.ts#L139
  # Status: built as of 931cb3f.
  @spec:id:01a1537a-61db-7608-933b-6500bb64e087
  @spec:demonstrates:01a1144e-51d6-7b17-8ef7-986d00f937e2
  @spec:demonstrates:01a15379-d8f7-7c0c-9b9a-05c07c64cc85
  Scenario: A null feature clears the View's tag
    Given a View tagged with the feature `checkout`
    When an Agent calls `update_view_metadata` with `feature` set to `null` and no `name`
    Then the View has no `feature` tag and keeps its name
    Then the View appears ungrouped
