Feature: Live refresh
  # Source: issue #69 (https://github.com/DevilTea/uiux/issues/69). Decisions behind the demonstrated Rules and Clauses: #1 c176 d5 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820; #1 c177 amended decisions https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@2afaee1 `tests/live-refresh-browser.test.ts#L65` "shows an Agent's MCP rename and its lease on an open View page without a reload, over one stream". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-refresh-browser.test.ts#L65
  # Test: code@2afaee1 `tests/live-events-http.test.ts#L248` "sends resource.changed for an MCP write to every open stream, and lock.changed for its lease". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events-http.test.ts#L248
  # Test: code@2afaee1 `tests/live-events-http.test.ts#L329` "sends lock.changed when the Owner force-releases a lease". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events-http.test.ts#L329
  # Test: code@2afaee1 `tests/live-events.test.ts#L214` "emits lock.changed for a lease that expired, found by the heartbeat sweep (Rule 01a114ec-e706-7c39-84a6-2e4a536daed2)". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events.test.ts#L214
  # Status: built as of 2afaee1.
  @spec:id:01a1590a-a2d6-770c-a167-c0a24bb0a977
  @spec:demonstrates:01a114ec-e706-7c39-84a6-2e4a536daed2
  Scenario: An Agent's edit lease appears on an open View page
    Given a member has a View open in the Workbench
    When an Agent writes that View through MCP, which takes its edit lease
    Then the View page shows that the Agent holds the lease without a reload
