Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #1 c157 d3 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18657198; #1 c159 promotion idempotency https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18660618.
  # Test: code@a021f9e `tests/transport-authoring.test.ts#L1066` "promotes review to decision atomically, updating target View with Decision provenance and returning Review and View URIs, and handles idempotency". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/transport-authoring.test.ts#L1066
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d4e9-7a62-9729-bb5a35f86034
  @spec:demonstrates:01a11544-6032-772b-b429-36a30800d70d
  @spec:demonstrates:01a11544-605b-7409-a010-fe345fb0284b
  Scenario: Promoting a thread again returns its existing Decision
    Given a thread already promoted to a Decision in its View
    When the promotion is retried with the original expected revisions
    Then it succeeds and returns the same Decision
    Then the View still has one Decision from that thread
