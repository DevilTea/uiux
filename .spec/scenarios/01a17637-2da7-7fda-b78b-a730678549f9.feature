Feature: Checks
  # Source: Discussion #241 owner rulings 2026-10-26, ruling 1 (issue #347). https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19186750
  # Test: [code@0cf269b `tests/checks-preview-browser.test.ts#L96` "lists a missing-key warning with its View, Widget and Property, and follows it to the Widget"](https://github.com/DevilTea/uiux/blob/0cf269b19a71ffc944e61dd2a2cb9087ff76fb53/tests/checks-preview-browser.test.ts#L96)
  # Status: built as of 0cf269b (issue #347).
  @spec:id:01a17637-2da6-74ea-b434-90537860ec0f
  @spec:demonstrates:01a115cd-b94f-7a87-830c-2060f2e63a2e
  @spec:demonstrates:01a115cd-bde8-736b-9153-7baaedf24f98
  @spec:demonstrates:01a17619-89fc-7a94-b690-2e65c6a99f39
  Scenario: A missing key in the live Preview appears in Checks with its Widget and Property
    Given a live Preview of a View with a Button whose label key is missing from the selected Locale
    When the Preview's Runtime evaluates the Button's result Property and the Preview sends a `checks.report`
    Then Checks lists a missing-translation warning grouped under that key
    Then the warning names the View, the Button Widget and its result Property
    Then no warning is listed for a Property the Runtime did not evaluate
