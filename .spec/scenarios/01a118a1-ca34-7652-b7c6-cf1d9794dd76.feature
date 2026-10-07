Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d7 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344; #7 c8 item 7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18758345; #7 c6 d9 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815.
  # Test: code@a021f9e `tests/review-resolution-and-hints.test.ts#L168` "keeps the tool registered with the decided description and refusal order, without touching the thread". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-resolution-and-hints.test.ts#L168
  # Test: code@a021f9e `tests/review-scope-and-edit.test.ts#L342` "keeps resolve Workbench-only for Workspace threads: MCP refuses it for agents and humans alike". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-scope-and-edit.test.ts#L342
  # Status: built as of a021f9e.
  @spec:id:01a118a1-ca34-76b7-a960-fb5a6c1bb4ec
  @spec:demonstrates:01a11485-f80f-77c2-8cb3-eaf9a09bdf57
  Scenario: An Agent cannot resolve a thread over MCP
    Given a thread ready for review
    Given an Agent member connected to `/mcp` with its Token
    When the Agent calls `resolve_review_thread` with the resolution verified
    Then the call is refused with `review.resolve_requires_human`
    Then the thread is unchanged
