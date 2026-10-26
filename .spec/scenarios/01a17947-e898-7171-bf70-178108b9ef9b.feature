Feature: An interaction change cites a replayable interaction record from the Workbench
  # Source: issue #61 (https://github.com/DevilTea/uiux/issues/61); Discussion #241 owner rulings 2026-10-26, ruling 6 (no currency check for `checks_run`, the picker preselects by change domain). https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851
  # Test: [code@52a9f0e `tests/review-submit-evidence-browser.test.ts#L121-L140` "preselects the passing replay for an interaction change, and cites a stale Flow trace without being refused"](https://github.com/DevilTea/uiux/blob/52a9f0e/tests/review-submit-evidence-browser.test.ts#L121-L140)
  # Test: [code@52a9f0e `tests/review-submission.test.ts#L69-L75` "picks the latest Run Checks record, the current Flow traces and the passing replays, each declared with its kind"](https://github.com/DevilTea/uiux/blob/52a9f0e/tests/review-submission.test.ts#L69-L75)
  # Status: built as of 52a9f0e.
  @spec:id:01a17947-e898-78cc-98a6-186017fd8496
  @spec:demonstrates:01a11544-55b0-7986-a32a-2a4fea7135d4
  @spec:demonstrates:01a11544-55fa-7b7e-aec5-e71b1ba9a214
  Scenario: An interaction change cites a replayable interaction record from the Workbench
    Given an open thread on a View with two interaction replay records of it, one with a failed assertion
    When a member chooses the `interaction` change domain in the Workbench dialog Submit for review
    When the member submits
    Then the dialog preselected only the replay whose assertions all passed
    Then the submission cites that record with kind `interaction_replay`
