Feature: Review desk
  # Source: Discussion #7 owner rulings 2026-10-09, ruling 3: Part 7 Scenarios for capture, the inbox link, the stale-key fallback, muted-pin activation and migration https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18820343; #7 c11 decision 7: the link carries the recorded Locale, viewport and theme https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18797092.
  # Test: code@0edbee8 `tests/review-inbox.test.ts#L179` "opens a Widget thread on its View in the recorded Locale, viewport and theme, with the thread open and its Widget selected (Rule 01a116f0-8ec3, Scenario 01a11e0e-435a)". https://github.com/DevilTea/uiux/blob/0edbee80010fb87d3bd052e109605606a3e40cbe/tests/review-inbox.test.ts#L179
  # Test: code@0edbee8 `tests/render-context-browser.test.ts#L128` "opens the thread from the inbox in its recorded context, offers the reader's own context instead, and never changes the chrome". https://github.com/DevilTea/uiux/blob/0edbee80010fb87d3bd052e109605606a3e40cbe/tests/render-context-browser.test.ts#L128
  # Status: built as of 0edbee8: the inbox link carries the recorded Locale, viewport and theme with the thread open and its Widget selected; 01a116f0-8ec3-7eff-9e61-4e1b3b31dabe has no open gap.
  @spec:id:01a11e0e-435a-790a-b4ee-dab23e4d578a
  @spec:demonstrates:01a116f0-8ec3-7eff-9e61-4e1b3b31dabe
  Scenario: An inbox link opens a thread in its recorded render context
    Given a Widget thread that records the Locale `zh-TW` and the viewport `mobile`
    Given a Reviewer who last previewed its View in `en-US` and the `desktop` viewport
    When the Reviewer opens the thread from the Reviews inbox
    Then the View opens in `zh-TW` and the `mobile` viewport
    Then the thread is open and its Widget is selected
