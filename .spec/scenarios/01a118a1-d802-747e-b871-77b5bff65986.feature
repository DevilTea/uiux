Feature: Preview canvas
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #2 c36 decision 7, R12 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18757811; #3 c4 decision 7 https://github.com/DevilTea/uiux/discussions/3#discussioncomment-18757813.
  # Test: code@a021f9e `tests/workbench-browser.test.ts#L935` "shows an edge indicator for a Widget scrolled out of the View and opens its thread without scrolling the iframe". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workbench-browser.test.ts#L935
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d802-7320-b00b-d6d31d07c82b
  @spec:demonstrates:01a11658-276a-7756-ac0e-1f1e00515e27
  Scenario: A pinned Widget outside the Preview viewport gets an edge indicator
    Given a thread on a Widget scrolled out of the Preview viewport
    When the Reviewer clicks the thread's edge indicator
    Then the thread opens
    Then the Preview does not scroll
