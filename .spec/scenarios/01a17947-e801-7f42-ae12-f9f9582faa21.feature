Feature: A purely textual change cites a Run Checks record from the Workbench instead of a capture
  # Source: issue #61 (https://github.com/DevilTea/uiux/issues/61); Discussion #241 owner rulings 2026-10-26, ruling 6 (no currency check for `checks_run`, the picker preselects by change domain). https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851
  # Test: [code@52a9f0e `tests/review-submit-evidence-browser.test.ts#L97-L119` "lists the Run Checks records, the Flow trace and the interaction replays, and preselects the latest run for an i18n change"](https://github.com/DevilTea/uiux/blob/52a9f0e/tests/review-submit-evidence-browser.test.ts#L97-L119)
  # Test: [code@52a9f0e `tests/review-submission.test.ts#L29-L40` "declares each cited record as the kind it has, so a Run Checks record is not sent as a capture (Rule 01a11544-55b0-…)"](https://github.com/DevilTea/uiux/blob/52a9f0e/tests/review-submission.test.ts#L29-L40)
  # Status: built as of 52a9f0e.
  @spec:id:01a17947-e801-7931-924b-7832ba89fa00
  @spec:demonstrates:01a11544-55b0-7986-a32a-2a4fea7135d4
  @spec:demonstrates:01a115cd-2ddd-7c3b-bd97-03d9d154f5d7
  Scenario: A purely textual change cites a Run Checks record from the Workbench instead of a capture
    Given an open thread on a View with a Run Checks record in the Workspace and no formal capture of it
    When a member chooses the `i18n` change domain in the Workbench dialog Submit for review
    When the member submits with the preselected Run Checks record
    Then the thread is ready for review
    Then the submission cites the record with kind `checks_run`
