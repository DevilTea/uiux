Feature: Live refresh
  # Source: issue #69 (https://github.com/DevilTea/uiux/issues/69). Decisions behind the demonstrated Rules and Clauses: #1 c176 d5 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820; #1 c177 amended decisions https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@2afaee1 `tests/live-events-http.test.ts#L365` "closes a session's stream when the session ends, and a Token's when it is revoked or its member removed". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events-http.test.ts#L365
  # Test: code@2afaee1 `tests/live-events.test.ts#L225` "closes a stream whose credential ended at the next check". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events.test.ts#L225
  # Status: built as of 2afaee1.
  @spec:id:01a1590a-a35f-7d2c-a5ac-10faac552a51
  @spec:demonstrates:01a11485-f3f6-72df-b43a-91905eb4970c
  Scenario: Ending a session closes its event stream
    Given a member has the change-event stream open on a Workbench session
    When the member signs out
    Then the server closes that stream
