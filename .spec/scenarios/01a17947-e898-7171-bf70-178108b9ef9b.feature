Feature: An interaction change cites a replayable interaction record from the Workbench
  # Source: issue #61 (https://github.com/DevilTea/uiux/issues/61); Discussion #241 owner rulings 2026-10-26, ruling 6 (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851), refined by the owner ruling 2026-10-27 on the preselection criteria (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19206918); issue #88, the owner ruling 2026-10-27 that a replay is shown as current or stale and preselected only when current (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19207759).
  # Test: [code@a33ec00 `tests/review-submit-evidence-browser.test.ts#L132-L156` "preselects the passing replay for an interaction change, and cites a stale Flow trace without being refused"](https://github.com/DevilTea/uiux/blob/a33ec00/tests/review-submit-evidence-browser.test.ts#L132-L156)
  # Test: [code@a33ec00 `tests/review-submit-evidence-browser.test.ts#L104-L130` "lists the Run Checks records, the Flow trace and the interaction replays, and preselects the latest run for an i18n change"](https://github.com/DevilTea/uiux/blob/a33ec00/tests/review-submit-evidence-browser.test.ts#L104-L130)
  # Test: [code@a33ec00 `tests/review-submission.test.ts#L71-L76` "picks the latest Run Checks record, the current Flow traces and the passing replays that are current, each declared with its kind"](https://github.com/DevilTea/uiux/blob/a33ec00/tests/review-submission.test.ts#L71-L76)
  # Test: [code@a33ec00 `tests/review-submission.test.ts#L78-L81` "does not preselect a replay that is stale or of unknown freshness, nor one without a freshness, but leaves it in the list"](https://github.com/DevilTea/uiux/blob/a33ec00/tests/review-submission.test.ts#L78-L81)
  # Test: [code@a33ec00 `tests/readiness-utils.test.ts#L95-L100` "judges an interaction_replay, which copies its capture context and provenance, as it judges a capture (Clause 01a14e30-2e43-…)"](https://github.com/DevilTea/uiux/blob/a33ec00/tests/readiness-utils.test.ts#L95-L100)
  # Status: built as of a33ec00.
  @spec:id:01a17947-e898-78cc-98a6-186017fd8496
  @spec:demonstrates:01a11544-55fa-7b7e-aec5-e71b1ba9a214
  @spec:demonstrates:01a14e30-2e43-75a7-aca8-c8df28915f4e
  @spec:demonstrates:01a17ac7-0ca5-78ab-83ac-22706a3a8716
  @spec:demonstrates:01a17ac7-0d42-7219-9c61-248a985ea028
  Scenario: An interaction change cites a replayable interaction record from the Workbench
    Given an open thread on a View with three interaction replay records of it, one with a failed assertion, one whose assertions all passed but that is stale, and one whose assertions all passed and that is current
    When a member chooses the `interaction` change domain in the Workbench dialog Submit for review
    When the member submits
    Then the dialog showed each replay as current or stale and preselected only the current replay whose assertions all passed
    Then the submission cites that record with kind `interaction_replay`
