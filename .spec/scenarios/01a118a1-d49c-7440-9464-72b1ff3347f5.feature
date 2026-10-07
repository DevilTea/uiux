Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #1 c18 the corresponding item in the owning View https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18561393; #7 c9 d6: promotion into any named View (O3-B) rejected https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Test: code@a021f9e `tests/transport-authoring.test.ts#L1165` "rejects Decision promotion into a View different from the Review anchor". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/transport-authoring.test.ts#L1165
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d49c-7736-8c85-7d56f68f96e3
  @spec:demonstrates:01a11544-5f90-7b18-a1b6-48c2bd167100
  Scenario: A thread is promoted only into its own View
    Given a thread anchored to one View
    When a Reviewer promotes it into another View
    Then the promotion is refused and neither View changes
