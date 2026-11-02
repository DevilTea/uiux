Feature: A Checks source that failed is shown as failed, not as zero findings
  # Source: Discussion #1 comment 75 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18610081 and Discussion #1 comment 77 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18610366 (check states; an unrun check is never zero findings).
  # Test: code@01f26de `tests/checks-sources-browser.test.ts#L195` "says a Catalog source that failed or did not finish is not a clean result". https://github.com/DevilTea/uiux/blob/01f26de/tests/checks-sources-browser.test.ts#L195
  # Test: code@01f26de `tests/checks-findings.test.ts#L132` "check states (Rule 01a115cd-bb96-7131-99d9-a3882829590c)". https://github.com/DevilTea/uiux/blob/01f26de/tests/checks-findings.test.ts#L132
  # Status: built as of 01f26de for the structural and schema, translation reminder, Catalog and Product Kit sources, as of 0cf269b and 10eed57 for the Preview sources, and as of b6295b5 for the Runtime errors source (01a115cd-bb96-7131-99d9-a3882829590c).
  @spec:id:01a1740e-cf30-7139-901d-93c66bc16107
  @spec:demonstrates:01a115cd-bb96-7131-99d9-a3882829590c
  Scenario: A Checks source that failed is shown as failed, not as zero findings
    Given the Adapter set's report cannot be read
    When a Reviewer runs Checks
    Then the Catalog source shows failed with no finding count
    Then the other sources keep their own states and findings
