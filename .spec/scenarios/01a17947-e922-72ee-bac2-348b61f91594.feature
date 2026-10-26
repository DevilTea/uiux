Feature: A Flow trace that is not current is shown as stale and can still be cited
  # Source: issue #61 (https://github.com/DevilTea/uiux/issues/61); Discussion #241 owner rulings 2026-10-26, ruling 6 (no currency check for `checks_run`, the picker preselects by change domain). https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851
  # Test: [code@52a9f0e `tests/review-submit-evidence-browser.test.ts#L121-L140` "preselects the passing replay for an interaction change, and cites a stale Flow trace without being refused"](https://github.com/DevilTea/uiux/blob/52a9f0e/tests/review-submit-evidence-browser.test.ts#L121-L140)
  # Test: [code@52a9f0e `tests/review-submission.test.ts#L85-L89` "is stale when the Flow changed or is gone, or a referenced capture is missing"](https://github.com/DevilTea/uiux/blob/52a9f0e/tests/review-submission.test.ts#L85-L89)
  # Status: built as of 52a9f0e.
  @spec:id:01a17947-e922-7e5d-81bb-a3087fc079f1
  @spec:demonstrates:01a11544-558b-7b86-b4c7-76928862c948
  Scenario: A Flow trace that is not current is shown as stale and can still be cited
    Given an open thread on a View and a Flow trace whose Flow changed after the trace ran
    When a member opens the Workbench dialog Submit for review
    When the member ticks the Flow trace and submits
    Then the dialog showed the trace as no longer current
    Then the thread is ready for review citing the trace, since currency is enforced only for formal captures
