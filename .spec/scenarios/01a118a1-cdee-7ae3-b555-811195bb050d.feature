Feature: Agent authoring over MCP
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c164 d3 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18671287; #1 c177 D16: `conflict` means re-read https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344; #7 c3 9a https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18674068.
  # Test: code@a021f9e `tests/transport-authoring.test.ts#L321` "rejects stale revision CAS conflict when updating structure without mutating persistence". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/transport-authoring.test.ts#L321
  # Test: code@a021f9e `tests/application-foundation.test.ts#L94` "returns a structured stale-revision conflict with exactly zero commit calls". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/application-foundation.test.ts#L94
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cdee-7559-a1d7-c6c187cf22d8
  @spec:demonstrates:01a11485-f4fe-7329-9ac4-3fad1651a13b
  @spec:demonstrates:01a11485-f53a-7cde-94d9-eddaf72cf88d
  Scenario: A write with a stale expected revision changes nothing
    Given an Agent read a View at one revision
    Given another member then changed that View
    When the Agent updates the View's structure with the revision it read
    Then nothing is written
    Then the result is a conflict that carries the View's current revision
