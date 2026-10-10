Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c176 baseline https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820. Amended by Discussion #174 (Part 16), Edit: the Scenario now refuses a non-loopback bind without a configured origin, and demonstrates 01a12500-a9c5-74e6-868a-2a6f4a5f3315 instead of 01a1144e-55ed-7276-8bfe-379be9881357 https://github.com/DevilTea/uiux/discussions/174; accepted as written 2026-10-10 https://github.com/DevilTea/uiux/discussions/174#discussioncomment-18848606.
  # Test: code@a021f9e `tests/loopback-guard.test.ts#L43` "refuses an explicit non-loopback bind and explains that LAN exposure needs authentication". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/loopback-guard.test.ts#L43
  # Status: partly built as of b9b9e71: every non-loopback bind is refused, as shown here, because no origin can be configured, and the bind address is set through `HOST` or `NITRO_HOST`, not `--host`; see the Implementation gaps entries of 01a12500-a9c5-74e6-868a-2a6f4a5f3315 and 01a11485-ee85-7844-b82f-fd6a7cebb763 in their owners.
  @spec:id:01a118a1-d20c-7436-b43a-45ccfba1cd04
  @spec:demonstrates:01a11485-ee85-7844-b82f-fd6a7cebb763
  @spec:demonstrates:01a12500-a9c5-74e6-868a-2a6f4a5f3315
  Scenario: The server refuses a non-loopback bind without a configured origin
    Given no origin is configured
    When `uiux dev` is started with a non-loopback bind address
    Then it refuses to start
