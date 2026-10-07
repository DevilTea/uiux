Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d4; withdraws the unauthenticated loopback mode of Part 1 item 12 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344; #1 c176 reply https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758349.
  # Test: code@a021f9e `tests/access-http.test.ts#L155` "answers /mcp without a valid token with 401, WWW-Authenticate and the fix, and ignores cookies there". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-http.test.ts#L155
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d08f-7cc3-8aa4-8620b0275126
  @spec:demonstrates:01a11485-ebc1-7a42-ab81-c12b6bb7903f
  @spec:demonstrates:01a11485-f68c-7754-908d-9237b1259327
  @spec:demonstrates:01a11485-f999-7aea-86eb-51121a341c8b
  Scenario: An MCP request without a Token is refused with the fix
    Given a running `uiux dev` server
    When an MCP client sends a request to `/mcp` without a credential
    Then the request is refused with HTTP 401 `auth.required` and a `WWW-Authenticate` header
    Then the message says to create a Token with `uiux token create` and send it as a bearer Token
