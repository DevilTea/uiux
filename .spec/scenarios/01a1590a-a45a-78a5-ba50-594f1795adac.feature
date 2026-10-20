Feature: Live refresh
  # Source: issue #69 (https://github.com/DevilTea/uiux/issues/69). Decisions behind the demonstrated Rules and Clauses: #1 c176 d5 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820; #1 c177 amended decisions https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@2c7fbee `tests/live-events-client.test.ts#L113` "falls back to polling when the stream is refused, and tries the stream again later". https://github.com/DevilTea/uiux/blob/2c7fbee84e6dfcf4f6f20c540c467390e7138b95/tests/live-events-client.test.ts#L113
  # Test: code@2c7fbee `tests/live-events-client.test.ts#L132` "polls without EventSource, and stops everything on stop()". https://github.com/DevilTea/uiux/blob/2c7fbee84e6dfcf4f6f20c540c467390e7138b95/tests/live-events-client.test.ts#L132
  # Status: built as of 2c7fbee.
  @spec:id:01a1590a-a45a-7a5f-9854-f1638f11fa9a
  @spec:demonstrates:01a11485-f3d9-7663-b344-a60c2a949e5e
  Scenario: Without the event stream the Workbench polls
    Given the change-event stream cannot connect
    When time passes while the Workbench is visible
    Then the Workbench re-reads what it shows at an interval
