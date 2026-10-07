Feature: Devices
  # Source: spec import batch 8 (Scenarios), priority P2. The demonstrated Rules and Clauses rest on owner rulings or code; see their owners' Rule sources.
  # Test: code@a021f9e `tests/review-feedback-browser.test.ts#L163` "shows a disabled Comment tool with its reason on a phone-width window". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-feedback-browser.test.ts#L163
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d8c8-7fbf-9a85-6808c1093211
  @spec:demonstrates:01a116f0-90e2-7a5a-b9d8-c80984d034ea
  Scenario: A phone cannot start a canvas comment
    Given the Workbench in a phone-width window
    When a Reviewer opens a View
    Then the Comment tool is disabled and says why
