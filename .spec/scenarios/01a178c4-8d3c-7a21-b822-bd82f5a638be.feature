Feature: A Preview report that names unevaluated Properties makes Checks' translation source incomplete
  # Source: Discussion #241 owner rulings 2026-10-26, ruling 5 (issue #95). https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851
  # Test: [code@10eed57 `tests/checks-findings.test.ts#L378-L384` "is completed when the report says every declared Property was evaluated, and incomplete when it names one it did not"](https://github.com/DevilTea/uiux/blob/10eed57/tests/checks-findings.test.ts#L378-L384)
  # Status: built as of 10eed57.
  @spec:id:01a178c4-8d3c-793c-8b39-034c7ce21607
  @spec:demonstrates:01a115cd-bb96-7131-99d9-a3882829590c
  @spec:demonstrates:01a178c4-7cdb-7072-9621-ed215ad45a97
  Scenario: A Preview report that names unevaluated Properties makes Checks' translation source incomplete
    Given a live Preview whose `checks.report` coverage names a declared Property it did not evaluate
    When Checks shows the Preview's sources
    Then the Preview's translation warnings source is incomplete and says how many Properties were not evaluated
    Then that source is never completed or shown as zero findings
