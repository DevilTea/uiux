Feature: A Preview that could not load shows Checks' translation source as failed
  # Source: Discussion #241 owner rulings 2026-10-26, ruling 5 (issue #95). https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851
  # Test: [code@10eed57 `tests/checks-findings.test.ts#L385-L391` "is failed for the translation source when the Preview could not evaluate, whatever the coverage says"](https://github.com/DevilTea/uiux/blob/10eed57/tests/checks-findings.test.ts#L385-L391)
  # Status: built as of 10eed57.
  @spec:id:01a178c4-9240-78ad-87bd-e7047f985132
  @spec:demonstrates:01a115cd-bb96-7131-99d9-a3882829590c
  @spec:demonstrates:01a178c4-7cdb-7072-9621-ed215ad45a97
  Scenario: A Preview that could not load shows Checks' translation source as failed
    Given a live Preview whose `checks.report` carries a `runtime.adapter_invalid` Runtime error
    When Checks shows the Preview's sources
    Then the Preview's translation warnings source is failed
    Then the Runtime error is still listed as a finding
