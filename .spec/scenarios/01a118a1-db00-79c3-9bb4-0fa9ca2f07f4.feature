Feature: Prototype playback
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #6 c8 d7 https://github.com/DevilTea/uiux/discussions/6#discussioncomment-18760681; #2 c37 d7 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18760678.
  # Test: code@a021f9e `tests/widget-events-browser.test.ts#L137` "advances on a click of the real Button, once per double click, and never sends an argument". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/widget-events-browser.test.ts#L137
  # Status: built as of a021f9e.
  @spec:id:01a118a1-db00-7d21-bb91-ee768e218a05
  @spec:demonstrates:01a11544-64b1-765f-b42b-58c94785768e
  @spec:demonstrates:01a11544-64db-7013-981d-a5cae3d71e5e
  Scenario: A double click advances the player only once
    Given a Prototype step whose Button click leads to the next step
    When the Reviewer double-clicks the Button
    Then the player advances exactly one step
    Then no Event argument reaches the player
