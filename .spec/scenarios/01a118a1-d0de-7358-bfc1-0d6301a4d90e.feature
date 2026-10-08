Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d2 concurrent writers; d9 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@a021f9e `tests/access-http.test.ts#L253` "applies a CLI revoke on the running server without a restart". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-http.test.ts#L253
  # Status: built as of a021f9e.
  # Note: Discussion #140 restates 01a11485-ea58-782e-9789-138833c868d9 with key changes, which are not built (issue #142); this Scenario exercises a revocation, which is built.
  @spec:id:01a118a1-d0de-704c-bb3b-6351ffdeb41c
  @spec:demonstrates:01a11485-ea58-782e-9789-138833c868d9
  @spec:demonstrates:01a11485-ecae-7f98-b096-39e37aae98df
  Scenario: A Token revoked from the CLI stops working on the running server
    Given a running `uiux dev` server
    Given an Agent using a member Token on it
    When the Owner revokes that Token with `uiux token revoke`
    Then the Agent's next request is refused as unauthenticated, without a server restart
