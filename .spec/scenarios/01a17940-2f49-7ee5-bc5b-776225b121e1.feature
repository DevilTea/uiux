Feature: A Preview report without coverage makes Checks' Runtime errors source incomplete, never zero findings
  # Source: [issue #370](https://github.com/DevilTea/uiux/issues/370), found in the review of PR #369 (issue #95); Rule 01a115cd-bb96-7131-99d9-a3882829590c.
  # Test: [code@b6295b5 `tests/checks-findings.test.ts#L388-L393` "is incomplete for the Runtime errors source when no Runtime was created, never completed with zero findings (issue #370)"](https://github.com/DevilTea/uiux/blob/b6295b595e61aed2b33c10f8f4612e34c344e95f/tests/checks-findings.test.ts#L388-L393)
  # Status: built as of b6295b5.
  @spec:id:01a17940-2f48-715a-a705-817e54b1e885
  @spec:demonstrates:01a115cd-bb96-7131-99d9-a3882829590c
  Scenario: A Preview report without coverage makes Checks' Runtime errors source incomplete, never zero findings
    Given a live Preview with no Runtime to inspect whose `checks.report` carries no coverage and no Runtime error
    When Checks shows the Preview's sources
    Then the Preview's Runtime errors source is incomplete
    Then it is not shown as completed with zero findings
