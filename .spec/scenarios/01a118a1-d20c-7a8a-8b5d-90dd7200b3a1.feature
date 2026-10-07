Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c176 baseline https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820.
  # Test: code@a021f9e `tests/loopback-guard.test.ts#L43` "refuses an explicit non-loopback bind and explains that LAN exposure needs authentication". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/loopback-guard.test.ts#L43
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d20c-7436-b43a-45ccfba1cd04
  @spec:demonstrates:01a1144e-55ed-7276-8bfe-379be9881357
  @spec:demonstrates:01a11485-ee85-7844-b82f-fd6a7cebb763
  Scenario: The server refuses a non-loopback bind without the LAN listener
    Given no LAN listener is requested
    When `uiux dev` is started with a non-loopback bind host
    Then it refuses to start
