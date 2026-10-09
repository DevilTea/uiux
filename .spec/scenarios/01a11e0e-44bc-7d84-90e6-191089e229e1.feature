Feature: Review desk
  # Source: Discussion #7 owner rulings 2026-10-09, ruling 3: Part 7 Scenarios for capture, the inbox link, the stale-key fallback, muted-pin activation and migration https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18820343; #7 c11 decision 11, R11, O1: activation switches the Preview context and keeps the chrome https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18797092.
  # Status: not built as of 11f8b7b; see the Implementation gaps entry of 01a1170f-c1f7-7e54-8754-c1a047415d4e in its owner.
  # Note: No test exists yet; tracked in issue #144.
  @spec:id:01a11e0e-44bc-79e7-847c-c345e11f0f3b
  @spec:demonstrates:01a1170f-c1f7-7e54-8754-c1a047415d4e
  Scenario: Activating a muted pin switches the Preview to the thread's recorded render context
    Given a Widget thread that records only the Locale `zh-TW`
    Given a Reviewer previews its View in `en-US`, the `mobile` viewport and the `dark` theme, so the thread's pin is muted
    When the Reviewer activates the muted pin
    Then the Preview shows `zh-TW` in the same Variant, the `mobile` viewport and the `dark` theme
    Then the thread opens and the Workbench chrome keeps its language and theme
