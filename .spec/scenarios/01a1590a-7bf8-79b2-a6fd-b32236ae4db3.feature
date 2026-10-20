Feature: Live refresh
  # Source: issue #69 (https://github.com/DevilTea/uiux/issues/69). Decisions behind the demonstrated Rules and Clauses: #1 c176 d5 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820; #1 c177 amended decisions https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@2afaee1 `tests/live-events-http.test.ts#L223` "sends resource.changed with the new revision for an HTTP write, and no canonical content". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events-http.test.ts#L223
  # Test: code@2afaee1 `tests/live-events-http.test.ts#L248` "sends resource.changed for an MCP write to every open stream, and lock.changed for its lease". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events-http.test.ts#L248
  # Test: code@2afaee1 `tests/live-events-http.test.ts#L280` "sends Review events without the message body: a new thread, a reply, and resource.removed for a retract". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events-http.test.ts#L280
  # Test: code@2afaee1 `tests/live-events.test.ts#L88` "maps a removal to resource.removed, and keeps only the content-free fields on the wire". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events.test.ts#L88
  # Test: code@2afaee1 `tests/live-events-http.test.ts#L315` "sends resource.changed for the Product Kit file (Discussion #241 owner decision 2)". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events-http.test.ts#L315
  # Status: built as of 2afaee1.
  @spec:id:01a1590a-7bf7-79e7-98af-b7dc7ab5aefe
  @spec:demonstrates:01a11485-f382-7307-b0c1-a1947715cf03
  @spec:demonstrates:01a114ec-e839-7b11-957c-41c88b692e12
  Scenario: Change events name what changed and carry no content
    Given a member has the change-event stream open
    When an Agent creates a View and replies on a Review thread
    Then the stream sends resource.changed with the kind, key and new revision of each
    Then no event carries the View's content, the reply's body or who wrote them
