Feature: A Flow trace that is not current is shown as stale and can still be cited
  # Source: issue #61 (https://github.com/DevilTea/uiux/issues/61); Discussion #241 owner rulings 2026-10-26, ruling 6 (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851), refined by the owner ruling 2026-10-27 on the preselection criteria (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19206918).
  # Test: [code@3dffbd9 `tests/review-submit-evidence-browser.test.ts#L125-L144` "preselects the passing replay for an interaction change, and cites a stale Flow trace without being refused"](https://github.com/DevilTea/uiux/blob/3dffbd9/tests/review-submit-evidence-browser.test.ts#L125-L144)
  # Test: [code@3bc4020 `tests/review-submission.test.ts#L92-L97` "is stale when the Flow changed or is gone, the trace records no Flow input digest, or a referenced capture is missing"](https://github.com/DevilTea/uiux/blob/3bc4020379b331eadcbfda7062f602b119a8736e/tests/review-submission.test.ts#L92-L97)
  # Test: [code@3bc4020 `tests/review-submission.test.ts#L104-L108` "is offered for a View only when a step of its Flow enters that View"](https://github.com/DevilTea/uiux/blob/3bc4020379b331eadcbfda7062f602b119a8736e/tests/review-submission.test.ts#L104-L108)
  # Status: built as of 3dffbd9.
  @spec:id:01a17947-e922-7e5d-81bb-a3087fc079f1
  @spec:demonstrates:01a11544-55b0-7986-a32a-2a4fea7135d4
  @spec:demonstrates:01a11544-6760-7ec2-8430-0f7cc5807259
  Scenario: A Flow trace that is not current is shown as stale and can still be cited
    Given an open thread on a View and a Flow trace whose Flow changed after the trace ran
    When a member opens the Workbench dialog Submit for review
    When the member ticks the Flow trace and submits
    Then the dialog showed the trace as no longer current
    Then the thread is ready for review citing the trace, since currency is enforced only for formal captures
