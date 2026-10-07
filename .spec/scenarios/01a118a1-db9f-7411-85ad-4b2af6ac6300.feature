Feature: Prototype playback
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #6 c2 d8 https://github.com/DevilTea/uiux/discussions/6#discussioncomment-18673004.
  # Test: code@a021f9e `tests/flows-browser.test.ts#L209` "still renders an invalid Flow and blocks Play with the reason". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/flows-browser.test.ts#L209
  # Test: code@a021f9e `tests/flow-graph.test.ts#L129` "reports unreachable, ambiguous and missing-target problems as save-blocking". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/flow-graph.test.ts#L129
  # Status: built as of a021f9e.
  @spec:id:01a118a1-db9f-7e6d-b7e4-cdccec714b71
  @spec:demonstrates:01a11544-6244-7a31-b37f-7f775a7d072a
  @spec:demonstrates:01a11544-62c8-7d37-933b-b991fed72e30
  @spec:demonstrates:01a115cd-3223-7e9e-abc8-a80f2efec2da
  Scenario: An invalid Flow stays viewable but cannot be played
    Given a UX Flow with a step that cannot be reached from its entry step
    When an Editor opens it
    Then the Flow still renders, with the problem named
    Then Play is blocked with the reason
