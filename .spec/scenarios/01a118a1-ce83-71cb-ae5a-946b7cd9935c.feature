Feature: Agent authoring over MCP
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d6 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344; #7 c8 item 3 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18758345; #7 c9 R9: edits record who and when https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Test: code@a021f9e `tests/access-policy.test.ts#L168` "stamps actor and at from the principal on HTTP, ignoring a supplied actor with auth.actor_ignored and at with auth.time_ignored". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-policy.test.ts#L168
  # Test: code@a021f9e `tests/access-policy.test.ts#L193` "stamps agents on /mcp too, so existing prompts that send actor keep working". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-policy.test.ts#L193
  # Status: built as of a021f9e.
  @spec:id:01a118a1-ce83-793e-bac7-4dc09b26d5f7
  @spec:demonstrates:01a11485-f134-71cb-ba9a-9b5709e092dc
  @spec:demonstrates:01a11485-f14e-74bd-be57-c20e26ca047b
  @spec:demonstrates:01a11485-f16a-7ca9-be79-a573298d4d23
  @spec:demonstrates:01a114ec-ec6a-760f-bd5c-c972e8ba2b9e
  Scenario: The server stamps the actor and time of an Agent's reply
    Given an Agent member connected to `/mcp` with its own Token
    When the Agent replies to a thread, supplying another actor and an authored time
    Then the reply records the Agent as its actor and the server's clock as its time
    Then the result warns with `auth.actor_ignored` and `auth.time_ignored`
