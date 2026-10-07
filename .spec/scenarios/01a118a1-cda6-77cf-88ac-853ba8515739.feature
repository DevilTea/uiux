Feature: Agent authoring over MCP
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 body: Agent Workflow via MCP https://github.com/DevilTea/uiux/discussions/1; #1 c164 d2 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18671287.
  # Test: code@a021f9e `tests/transport-authoring.test.ts#L50` "creates a spec-first View, returns its stable Resource URI, and updates the Spec with revision CAS". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/transport-authoring.test.ts#L50
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cda6-722d-8865-81bf804e8bcb
  @spec:demonstrates:01a11485-f55a-708e-baf7-9195d6514efc
  @spec:demonstrates:01a11485-f748-7f7d-9b31-6afecb20ba4b
  Scenario: An Agent creates a View and writes its Spec
    Given an Agent member with the Editor role connected to `/mcp`
    When the Agent creates a View with `create_view`
    When the Agent updates its Spec with `update_view_spec` and the revision the create returned
    Then the View has the canonical empty RootShell structure and the new Spec
    Then each result returns the View's new revision
