Feature: Review desk
  # Source: Discussion #7 owner rulings 2026-10-09, ruling 3: Part 7 Scenarios for capture, the inbox link, the stale-key fallback, muted-pin activation and migration https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18820343; #7 c11 decision 5, R5: a stale key never invalidates the anchor and is never rebound https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18797092.
  # Status: not built as of 11f8b7b; see the Implementation gaps entries of 01a1170f-c165-7dd4-bc9f-a799f7884f14 and 01a1170f-baf0-7eea-a904-7367227c10b3 in their owners.
  # Note: No test exists yet; tracked in issue #144. The decoder already accepts a stale key unchanged (01a1170f-baf0-7eea-a904-7367227c10b3 is partly built).
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
