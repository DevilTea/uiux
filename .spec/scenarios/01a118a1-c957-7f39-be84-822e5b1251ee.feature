Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c158 d3 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18657409; #1 body: Workflows, Reviews, & Decisions https://github.com/DevilTea/uiux/discussions/1; #7 c5 d6 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814; #1 c174 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757817.
  # Test: code@a021f9e `tests/workbench-browser.test.ts#L915` "lists a thread whose Widget was deleted in the unplaced tray and never draws its pin". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workbench-browser.test.ts#L915
  # Status: built as of a021f9e.
  @spec:id:01a118a1-c957-733d-a0eb-a51b8f0bd277
  @spec:demonstrates:01a11544-5228-70b4-96be-e5e032bb3b63
  @spec:demonstrates:01a11544-524d-7fd7-aa5e-d3f4388bdd41
  @spec:demonstrates:01a11544-5d60-705e-b88a-d2e8743cba14
  Scenario: A thread survives the removal of its Widget
    Given an open thread is anchored to a Widget that its View no longer contains
    When a Reviewer opens the View
    Then the thread stays open and is listed among the comments that cannot be placed
    Then it draws no pin, and opening it shows a missing-target notice
