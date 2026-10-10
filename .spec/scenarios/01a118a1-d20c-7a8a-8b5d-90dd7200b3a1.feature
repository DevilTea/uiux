Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c176 baseline https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820. Amended by Discussion #174 (Part 16), Edit: the Scenario now refuses a non-loopback bind without a configured origin, and demonstrates 01a12500-a9c5-74e6-868a-2a6f4a5f3315 instead of 01a1144e-55ed-7276-8bfe-379be9881357 https://github.com/DevilTea/uiux/discussions/174; accepted as written 2026-10-10 https://github.com/DevilTea/uiux/discussions/174#discussioncomment-18848606. Owner ruling 2 (https://github.com/DevilTea/uiux/discussions/174#discussioncomment-18848916) leaves a wildcard address as the only non-loopback bind, so the Scenario binds a wildcard address; after ruling 3 it no longer demonstrates 01a11485-ee85-7844-b82f-fd6a7cebb763, which is about the packaged server run directly.
  # Test: code@be5692f `tests/network-access.test.ts#L158` "refuses a wildcard bind without an origin". https://github.com/DevilTea/uiux/blob/be5692f7ad625c0b3122ee642e95d2c72d7d03fd/tests/network-access.test.ts#L158
  # Test: code@be5692f `tests/network-access.test.ts#L68` "refuses a wildcard bind without an origin (Rule 01a12500-a9c5-74e6-868a-2a6f4a5f3315) and defaults to loopback". https://github.com/DevilTea/uiux/blob/be5692f7ad625c0b3122ee642e95d2c72d7d03fd/tests/network-access.test.ts#L68
  # Test: code@0297fb9 `scripts/smoke-server.mjs#L249` "smokeLoopbackOnlyCli: uiux dev --host 0.0.0.0 without an origin". https://github.com/DevilTea/uiux/blob/0297fb927d1434cbfcdca592b2408747c6298b2b/scripts/smoke-server.mjs#L249
  # Status: built as of be5692f: `uiux dev --host 0.0.0.0` and `--host ::` without `--origin` refuse to start.
  @spec:id:01a118a1-d20c-7436-b43a-45ccfba1cd04
  @spec:demonstrates:01a12500-a9c5-74e6-868a-2a6f4a5f3315
  Scenario: The server refuses a wildcard bind without a configured origin
    Given no origin is configured
    When `uiux dev` is started with a wildcard bind address
    Then it refuses to start
