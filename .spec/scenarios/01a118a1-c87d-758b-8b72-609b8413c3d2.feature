Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c158 d1 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18657409; #1 body: Workflows, Reviews, & Decisions https://github.com/DevilTea/uiux/discussions/1; #7 c5 d2, d6 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814.
  # Test: code@a021f9e `tests/workbench-browser.test.ts#L819` "comments with C, a click and Ctrl+Enter at the click point, keeps the pin there after reload, replies, resolves and filters". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workbench-browser.test.ts#L819
  # Status: built as of a021f9e.
  @spec:id:01a118a1-c87d-77c5-9af7-5c2c460f2321
  @spec:demonstrates:01a11544-514a-733b-955a-614571facc1c
  @spec:demonstrates:01a11544-5cc6-7e81-9a4d-b7a0383fa7e9
  Scenario: A Reviewer comments on a Widget from the canvas
    Given a View is open in the Workbench with the Comment tool
    When the Reviewer clicks a Widget in the Preview and posts a comment
    Then a thread anchored to the View and to that Widget's identity is created
    Then after a reload its pin is drawn at the clicked point within the Widget
