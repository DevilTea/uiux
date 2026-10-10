Feature: Agent authoring over MCP
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d5, D11 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344. Restated as permission keys by Discussion #140 (Part 15), decision 12, A: MCP; R26; owner answer Q9 https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: built as of 98672a4.
  # Test: code@98672a4 `tests/access-policy.test.ts#L399` "keeps every tool listed whatever the keys and refuses one the keys do not allow, naming the missing key (Scenario 01a118a1-cecf)". https://github.com/DevilTea/uiux/blob/98672a48d3d0babd56b8d471322cb3eea13f0d7f/tests/access-policy.test.ts#L399
  @spec:id:01a118a1-cecf-7786-88b9-6027d92adaeb
  @spec:demonstrates:01a11485-f247-7f43-abda-bbee6e390892
  @spec:demonstrates:01a11485-f9bd-78a3-a1d0-1b4f64e9883e
  Scenario: A tool the caller's keys do not allow stays listed and refuses
    Given a member Token whose keys hold `workspace.read` but not `views.write`, connected to `/mcp`
    When the client lists the tools and calls `create_view`
    Then the list still includes `create_view`
    Then the call is refused with `auth.scope_denied` whose `requiredKeys` is `views.write`, and the Workspace is untouched
