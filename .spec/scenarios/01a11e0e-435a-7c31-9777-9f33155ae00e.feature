Feature: Review desk
  # Source: Discussion #7 owner rulings 2026-10-09, ruling 3: Part 7 Scenarios for capture, the inbox link, the stale-key fallback, muted-pin activation and migration https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18820343; #7 c11 decision 7: the link carries the recorded Locale, viewport and theme https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18797092.
  # Status: partly built as of 673d086: the inbox link opens the View with the thread open and its Widget selected, but carries no Locale, viewport or theme; see the Implementation gaps entry of 01a116f0-8ec3-7eff-9e61-4e1b3b31dabe in its owner.
  # Note: No test of the render-context part exists yet; tracked in issue #144.
  @spec:id:01a11e0e-435a-790a-b4ee-dab23e4d578a
  @spec:demonstrates:01a116f0-8ec3-7eff-9e61-4e1b3b31dabe
  Scenario: An inbox link opens a thread in its recorded render context
    Given a Widget thread that records the Locale `zh-TW` and the viewport `mobile`
    Given a Reviewer who last previewed its View in `en-US` and the `desktop` viewport
    When the Reviewer opens the thread from the Reviews inbox
    Then the View opens in `zh-TW` and the `mobile` viewport
    Then the thread is open and its Widget is selected
