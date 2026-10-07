Feature: Preview canvas
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #2 c27 d3 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18655326; #3 c6 item 2.1 https://github.com/DevilTea/uiux/discussions/3#discussioncomment-18760674.
  # Test: code@a021f9e `tests/review-feedback-browser.test.ts#L135` "keeps comment targeting, Escape, pins and the palette after moving between Views in the app". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-feedback-browser.test.ts#L135
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d7b4-725a-b1d9-3f51e3e7a60d
  @spec:demonstrates:01a11658-21c1-7f67-8158-7516905a6a98
  Scenario: Escape in the Preview leaves Comment mode
    Given Comment mode is on and focus is inside the Preview
    When the Reviewer presses Escape
    Then the Workbench leaves Comment mode and clears its targeting overlays
