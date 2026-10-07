Feature: Agent authoring over MCP
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d5, D11 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@a021f9e `tests/access-policy.test.ts#L118` "refuses every write below its role before touching the Workspace, on HTTP and on MCP". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-policy.test.ts#L118
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cecf-7786-88b9-6027d92adaeb
  @spec:demonstrates:01a11485-f247-7f43-abda-bbee6e390892
  @spec:demonstrates:01a11485-f9bd-78a3-a1d0-1b4f64e9883e
  Scenario: A tool the role cannot use stays listed and refuses
    Given a Viewer's Token connected to `/mcp`
    When the client lists the tools and calls `create_view`
    Then the list still includes `create_view`
    Then the call is refused with `auth.scope_denied` naming the Editor role, and the Workspace is untouched
