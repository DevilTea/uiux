Feature: Checks
  # Source: Discussion #241 owner rulings 2026-10-26, ruling 1 (issue #347). https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19186750
  # Test: [code@0cf269b `tests/checks-preview-browser.test.ts#L167` "replaces what was reported when the Variant changes"](https://github.com/DevilTea/uiux/blob/0cf269b19a71ffc944e61dd2a2cb9087ff76fb53/tests/checks-preview-browser.test.ts#L167)
  # Status: built as of 0cf269b (issue #347).
  @spec:id:01a17637-4606-7709-8e87-4f57401e93b8
  @spec:demonstrates:01a115cd-b9fc-71d9-8bf9-91d65acd1096
  @spec:demonstrates:01a17619-ab3f-797d-ae93-4038a48ee31f
  Scenario: Switching Variant replaces what the Preview reported to Checks
    Given a live Preview of the base state whose `checks.report` listed a missing-translation warning
    When the person switches to a Variant
    When the Preview sends a `checks.report` of the Variant with a higher `sequence`
    Then Checks lists only what the Variant's report holds, each finding under that Variant
    Then nothing of the base state's report is still listed as current
