Feature: Workbench links and chrome
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c4 deep links to the exact render context https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18547636.
  # Test: code@a021f9e `tests/workbench-browser.test.ts#L300` "reproduces a deep-linked render context, Widget and thread after reload". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workbench-browser.test.ts#L300
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d2a1-766b-97f0-baba462acce1
  @spec:demonstrates:01a116f0-8f4c-7fac-a46d-53d8dba61dfa
  @spec:demonstrates:01a116f0-97c8-7f7b-93d6-86568b177cae
  Scenario: A View link reproduces the render context, Widget and thread
    Given a Reviewer has a View open in a non-default Locale, viewport and theme, with a Widget selected and a thread open
    When another member opens the copied address
    Then the View opens in the same Variant, Locale, viewport and theme
    Then the same Widget is selected and the same thread is open
