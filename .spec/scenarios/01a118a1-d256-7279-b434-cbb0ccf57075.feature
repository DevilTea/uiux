Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d3 scope = role: the LAN flag; d5; D8; Session model https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344; #1 c176 reply https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758349.
  # Status: not built as of a021f9e; see the Implementation gaps entry of 01a11485-ef0e-7dd9-990b-457db879c039 in its owner.
  # Note: No test exists yet; `tests/access-store.test.ts` only checks that Tokens record the LAN flag.
  @spec:id:01a118a1-d256-7164-88b3-cbd3b6357f04
  @spec:demonstrates:01a11485-ef0e-7dd9-990b-457db879c039
  @spec:demonstrates:01a11485-f6ca-7454-9c06-965899fca8b4
  Scenario: A Token created without the LAN flag is refused on the LAN listener
    Given `uiux dev` runs with the LAN listener
    Given an Agent holds a Token created without the LAN flag
    When the Agent calls `/mcp` on the LAN origin
    Then the request is refused with HTTP 403 `auth.lan_not_allowed`
    Then the same Token keeps working on the loopback listener
