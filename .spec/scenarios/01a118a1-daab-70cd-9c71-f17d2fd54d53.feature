Feature: Prototype playback
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #6 c3 10c https://github.com/DevilTea/uiux/discussions/6#discussioncomment-18673622; #6 c2 d6 https://github.com/DevilTea/uiux/discussions/6#discussioncomment-18673004; #6 c8 ratified reading: one step entry is one runtime generation https://github.com/DevilTea/uiux/discussions/6#discussioncomment-18760681.
  # Test: code@a021f9e `tests/flows-browser.test.ts#L242` "starts at the entry step and creates a fresh runtime on every step entry". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/flows-browser.test.ts#L242
  # Test: code@a021f9e `tests/flow-graph.test.ts#L186` "gives every step entry a new entry, including returns and restarts, so no prior state is restored". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/flow-graph.test.ts#L186
  # Status: built as of a021f9e.
  @spec:id:01a118a1-daab-7a6b-b713-4b0b9da3c1b9
  @spec:demonstrates:01a11544-6409-7570-9bc7-1f74097739e8
  @spec:demonstrates:01a11544-6434-779d-8de4-8130392ca913
  @spec:demonstrates:01a115cd-327f-7aa6-940d-3ef6749c4efc
  Scenario: Every step entry starts from a fresh Runtime
    Given a UX Flow whose entry step leads to a second step and back
    When the Reviewer plays it, changes a Widget's state in the entry step, advances and returns
    Then the player starts at the entry step
    Then the returned entry step shows its View's initial state again
