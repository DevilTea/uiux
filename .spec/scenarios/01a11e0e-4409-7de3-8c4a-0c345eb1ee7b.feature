Feature: Review desk
  # Source: Discussion #7 owner rulings 2026-10-09, ruling 3: Part 7 Scenarios for capture, the inbox link, the stale-key fallback, muted-pin activation and migration https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18820343; #7 c11 decision 5, R5: a stale key never invalidates the anchor and is never rebound https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18797092.
  # Test: code@0edbee8 `tests/review-inbox.test.ts#L195` "drops a stale key so it opens with its default, keeps the other members, and reports it for the notice (Rule 01a1170f-c165, Scenario 01a11e0e-4409)". https://github.com/DevilTea/uiux/blob/0edbee80010fb87d3bd052e109605606a3e40cbe/tests/review-inbox.test.ts#L195
  # Test: code@0edbee8 `tests/render-context-options.test.ts#L320` "splits a recorded context into the members that exist and the stale ones, never rebinding (Rule 01a1170f-c165)". https://github.com/DevilTea/uiux/blob/0edbee80010fb87d3bd052e109605606a3e40cbe/tests/render-context-options.test.ts#L320
  # Test: code@0edbee8 `tests/render-context-browser.test.ts#L166` "opens with the default viewport and a notice naming it once the recorded viewport is removed from the settings". https://github.com/DevilTea/uiux/blob/0edbee80010fb87d3bd052e109605606a3e40cbe/tests/render-context-browser.test.ts#L166
  # Status: built as of 0edbee8 for this path, opening from the Reviews inbox; 01a1170f-c165-7dd4-bc9f-a799f7884f14 stays partly built until activating a muted pin falls back the same way (see its Implementation gaps entry, issue #144).
  # Note: The decoder keeps a stale key unchanged (01a1170f-baf0-7eea-a904-7367227c10b3 has no open gap since PR #151).
  @spec:id:01a11e0e-4409-7ae2-b94f-22454cd0dca1
  @spec:demonstrates:01a1170f-baf0-7eea-a904-7367227c10b3
  @spec:demonstrates:01a1170f-c165-7dd4-bc9f-a799f7884f14
  Scenario: A thread whose recorded viewport was removed opens with the default viewport and a notice
    Given a Widget thread that records the Locale `zh-TW` and the viewport `mobile`
    Given the viewport `mobile` was later removed from the Workspace settings
    When a Reviewer opens the thread from the Reviews inbox
    Then the View opens in `zh-TW` and the default viewport
    Then a non-blocking notice names the missing viewport
    Then the thread still records the viewport `mobile`
