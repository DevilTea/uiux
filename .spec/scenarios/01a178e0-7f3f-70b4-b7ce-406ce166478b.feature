Feature: A Preview report without coverage makes Checks' translation source incomplete, never zero findings
  # Source: Discussion #241 owner rulings 2026-10-26, ruling 5 (issue #95). https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851
  # Test: [code@f0838ef `tests/checks-findings.test.ts#L384-L386` "is incomplete, never completed, for a report without coverage: a Preview with no Runtime to inspect has verified nothing"](https://github.com/DevilTea/uiux/blob/f0838ef/tests/checks-findings.test.ts#L384-L386)
  # Status: built as of f0838ef.
  @spec:id:01a178e0-7f3e-70aa-8070-b44c99c38f44
  @spec:demonstrates:01a115cd-bb96-7131-99d9-a3882829590c
  @spec:demonstrates:01a178c4-7cdb-7072-9621-ed215ad45a97
  Scenario: A Preview report without coverage makes Checks' translation source incomplete, never zero findings
    Given a live Preview with no Runtime to inspect whose `checks.report` carries no coverage and no Runtime error
    When Checks shows the Preview's sources
    Then the Preview's translation warnings source is incomplete
    Then it is not shown as completed with zero findings
