Feature: An interaction change cites a replayable interaction record from the Workbench
  # Source: issue #61 (https://github.com/DevilTea/uiux/issues/61); Discussion #241 owner rulings 2026-10-26, ruling 6 (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851), refined by the owner ruling 2026-10-27 on the preselection criteria (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19206918).
  # Test: [code@3dffbd9 `tests/review-submit-evidence-browser.test.ts#L125-L144` "preselects the passing replay for an interaction change, and cites a stale Flow trace without being refused"](https://github.com/DevilTea/uiux/blob/3dffbd9/tests/review-submit-evidence-browser.test.ts#L125-L144)
  # Test: [code@3dffbd9 `tests/review-submission.test.ts#L63-L74` "picks the latest Run Checks record, the current Flow traces and the passing replays, each declared with its kind"](https://github.com/DevilTea/uiux/blob/3dffbd9/tests/review-submission.test.ts#L63-L74)
  # Status: built as of 3dffbd9.
  @spec:id:01a17947-e898-78cc-98a6-186017fd8496
  @spec:demonstrates:01a11544-55fa-7b7e-aec5-e71b1ba9a214
  @spec:demonstrates:01a17ac7-0ca5-78ab-83ac-22706a3a8716
  @spec:demonstrates:01a17ac7-0d42-7219-9c61-248a985ea028
  Scenario: An interaction change cites a replayable interaction record from the Workbench
    Given an open thread on a View with two interaction replay records of it, one with a failed assertion
    When a member chooses the `interaction` change domain in the Workbench dialog Submit for review
    When the member submits
    Then the dialog preselected only the replay whose assertions all passed
    Then the submission cites that record with kind `interaction_replay`
