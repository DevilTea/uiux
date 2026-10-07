Feature: Workbench authoring
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c176 d6 rules 3 and 4; R11 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820; #1 c167 d3 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18671913.
  # Test: code@a021f9e `tests/workbench-authoring-pages.test.ts#L78` "shows the conflict alert on a concurrent agent write and keeps the draft". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workbench-authoring-pages.test.ts#L78
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cf18-799e-9d7c-8b13c9d15086
  @spec:demonstrates:01a11485-f451-72eb-81ad-686aeec7b3eb
  Scenario: The Workbench keeps the draft after a revision conflict
    Given an Editor is editing Workspace Settings in the Workbench
    Given an Agent changes the same settings meanwhile
    When the Editor saves
    Then the save is refused for the conflict and nothing is resent automatically
    Then the Editor's draft is kept while the new state is shown
