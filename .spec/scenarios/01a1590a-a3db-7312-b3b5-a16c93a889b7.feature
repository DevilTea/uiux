Feature: Live refresh
  # Source: issue #69 (https://github.com/DevilTea/uiux/issues/69). Decisions behind the demonstrated Rules and Clauses: #1 c176 d5 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820; #1 c177 amended decisions https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@3bc4020 `tests/live-events-client.test.ts#L100-L127` "resyncs everything on the first hello (a write before the stream was accepted is never sent), after a reconnect, and when the server instance changes". https://github.com/DevilTea/uiux/blob/3bc4020379b331eadcbfda7062f602b119a8736e/tests/live-events-client.test.ts#L100-L127
  # Test: code@2afaee1 `tests/live-events-http.test.ts#L211` "ignores Last-Event-ID: a reconnect gets a fresh hello and nothing replayed". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events-http.test.ts#L211
  # Test: code@2afaee1 `tests/live-events.test.ts#L95` "gives every bus its own server instance ID, so a restarted server is told apart (Rule 01a11485-f39f-7464-9f8f-608335ed9800)". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events.test.ts#L95
  # Status: built as of 2afaee1.
  @spec:id:01a1590a-a3db-7555-9a0d-ae78f7106a56
  @spec:demonstrates:01a11485-f39f-7464-9f8f-608335ed9800
  Scenario: A reconnect or a restarted server resynchronizes the Workbench
    Given the Workbench's change-event stream dropped
    When the stream connects again, or names a new server instance
    Then the Workbench re-reads everything it shows
    Then nothing missed while it was disconnected is replayed
