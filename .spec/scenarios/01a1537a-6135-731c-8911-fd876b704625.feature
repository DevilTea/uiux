Feature: Agent authoring over MCP
  # Source: Discussion #241 (Part 18), proposal and owner acceptance "View rename (#56)", 2026-10-19 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19036740; issue #56 https://github.com/DevilTea/uiux/issues/56.
  # Status: not built as of dff1553; see the Implementation gaps entry of 01a15379-d8f7-7c0c-9b9a-05c07c64cc85 in its owner.
  # Note: No test exists yet.
  @spec:id:01a1537a-6135-759d-a23b-9ed8c8d58c81
  @spec:demonstrates:01a11485-f53a-7cde-94d9-eddaf72cf88d
  @spec:demonstrates:01a15379-d8f7-7c0c-9b9a-05c07c64cc85
  Scenario: A rename with a stale revision is refused
    Given an Agent that read a View at one revision
    Given another member has since changed that View
    When the Agent renames the View with `update_view_metadata` and the revision it read
    Then the rename is refused as `conflict` carrying the View's current revision
    Then the View's name is unchanged
