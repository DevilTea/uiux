Feature: Live refresh
  # Source: issue #69 (https://github.com/DevilTea/uiux/issues/69). Decisions behind the demonstrated Rules and Clauses: #1 c176 d5 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820; #1 c177 amended decisions https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@2c7fbee `tests/live-events-http.test.ts#L219` "sends resource.changed with the new revision for an HTTP write, and no canonical content". https://github.com/DevilTea/uiux/blob/2c7fbee84e6dfcf4f6f20c540c467390e7138b95/tests/live-events-http.test.ts#L219
  # Test: code@2c7fbee `tests/live-events-http.test.ts#L244` "sends resource.changed for an MCP write to every open stream, and lock.changed for its lease". https://github.com/DevilTea/uiux/blob/2c7fbee84e6dfcf4f6f20c540c467390e7138b95/tests/live-events-http.test.ts#L244
  # Test: code@2c7fbee `tests/live-events-http.test.ts#L276` "sends Review events without the message body: a new thread, a reply, and resource.removed for a retract". https://github.com/DevilTea/uiux/blob/2c7fbee84e6dfcf4f6f20c540c467390e7138b95/tests/live-events-http.test.ts#L276
  # Test: code@2c7fbee `tests/live-events.test.ts#L87` "maps a removal to resource.removed, and keeps only the content-free fields on the wire". https://github.com/DevilTea/uiux/blob/2c7fbee84e6dfcf4f6f20c540c467390e7138b95/tests/live-events.test.ts#L87
  # Status: built as of 2c7fbee.
  @spec:id:01a1590a-7bf7-79e7-98af-b7dc7ab5aefe
  @spec:demonstrates:01a11485-f382-7307-b0c1-a1947715cf03
  @spec:demonstrates:01a114ec-e839-7b11-957c-41c88b692e12
  Scenario: Change events name what changed and carry no content
    Given a member has the change-event stream open
    When an Agent creates a View and replies on a Review thread
    Then the stream sends resource.changed with the kind, key and new revision of each
    Then no event carries the View's content, the reply's body or who wrote them
