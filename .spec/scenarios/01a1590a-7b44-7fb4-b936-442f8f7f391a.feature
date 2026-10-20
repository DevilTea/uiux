Feature: Live refresh
  # Source: issue #69 (https://github.com/DevilTea/uiux/issues/69). Decisions behind the demonstrated Rules and Clauses: #1 c176 d5 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820; #1 c177 amended decisions https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@2afaee1 `tests/live-refresh-browser.test.ts#L65` "shows an Agent's MCP rename and its lease on an open View page without a reload, over one stream". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-refresh-browser.test.ts#L65
  # Test: code@2afaee1 `tests/live-events-http.test.ts#L248` "sends resource.changed for an MCP write to every open stream, and lock.changed for its lease". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events-http.test.ts#L248
  # Test: code@2afaee1 `tests/live-events.test.ts#L48` "emits one resource.changed per committed resource with the revision reads return, the View and the Review of a promotion both". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events.test.ts#L48
  # Status: built as of 2afaee1.
  @spec:id:01a1590a-7b44-76cb-8e75-ffe59d42f8fb
  @spec:demonstrates:01a11485-f365-70ce-82d9-43ea3f5ea5bb
  @spec:demonstrates:01a11485-f3bb-760b-9132-0e8c2f6bbf43
  @spec:demonstrates:01a11485-f414-7882-b94f-cd4236c26d89
  Scenario: An Agent's MCP write appears on an open Workbench without a reload
    Given a member has a View open in the Workbench
    When an Agent renames that View through MCP
    Then the View page shows the new name without a reload
