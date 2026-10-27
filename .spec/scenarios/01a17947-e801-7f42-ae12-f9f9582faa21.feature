Feature: Choosing the i18n change domain preselects the newest Run Checks record, which the submission cites
  # Source: issue #61 (https://github.com/DevilTea/uiux/issues/61); Discussion #241 owner rulings 2026-10-26, ruling 6 (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851), refined by the owner ruling 2026-10-27 on the preselection criteria (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19206918).
  # Test: [code@3dffbd9 `tests/review-submit-evidence-browser.test.ts#L100-L123` "lists the Run Checks records, the Flow trace and the interaction replays, and preselects the latest run for an i18n change"](https://github.com/DevilTea/uiux/blob/3dffbd9/tests/review-submit-evidence-browser.test.ts#L100-L123)
  # Test: [code@3dffbd9 `tests/review-submission.test.ts#L29-L40` "declares each cited record as the kind it has, so a Run Checks record is not sent as a capture (Rule 01a11544-55b0-…)"](https://github.com/DevilTea/uiux/blob/3dffbd9/tests/review-submission.test.ts#L29-L40)
  # Test: [code@3dffbd9 `tests/review-submission.test.ts#L63-L74` "picks the latest Run Checks record, the current Flow traces and the passing replays, each declared with its kind"](https://github.com/DevilTea/uiux/blob/3dffbd9/tests/review-submission.test.ts#L63-L74)
  # Status: built as of 3dffbd9.
  @spec:id:01a17947-e801-7931-924b-7832ba89fa00
  @spec:demonstrates:01a11544-55b0-7986-a32a-2a4fea7135d4
  @spec:demonstrates:01a17ac7-0ca5-78ab-83ac-22706a3a8716
  @spec:demonstrates:01a17ac7-0d42-7219-9c61-248a985ea028
  Scenario: Choosing the i18n change domain preselects the newest Run Checks record, which the submission cites
    Given an open thread on a View with a Run Checks record in the Workspace and no formal capture of it
    When a member chooses the `i18n` change domain in the Workbench dialog Submit for review
    When the member submits with the preselected Run Checks record
    Then the thread is ready for review
    Then the submission cites the record with kind `checks_run`
