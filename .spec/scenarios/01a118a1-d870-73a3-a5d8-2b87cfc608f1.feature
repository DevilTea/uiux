Feature: Workbench links and chrome
  # Source: spec import batch 8 (Scenarios), priority P2. The demonstrated Rules and Clauses rest on owner rulings or code; see their owners' Rule sources.
  # Test: code@a021f9e `tests/workbench-browser.test.ts#L321` "keeps the Workbench language and theme independent of the Preview Locale and theme". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workbench-browser.test.ts#L321
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d870-72d9-91a6-4d93e364fd53
  @spec:demonstrates:01a116f0-930a-79a1-912c-f254ff9d8bd6
  Scenario: The chrome language and the Preview Locale change independently
    Given the chrome is in English and the Preview shows the en-US Locale in the light theme
    When the user switches the chrome to Traditional Chinese
    When the user switches the Preview to another Locale and theme
    Then the Preview Locale did not change with the chrome
    Then the chrome language and theme did not change with the Preview
