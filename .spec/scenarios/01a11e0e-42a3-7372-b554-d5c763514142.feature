Feature: Review desk
  # Source: Discussion #7 owner rulings 2026-10-09, ruling 3: Part 7 Scenarios for capture, the inbox link, the stale-key fallback, muted-pin activation and migration https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18820343; #7 c11 decision 2 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18797092; ruling 2: only Workspace-authored keys are recorded https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18820343.
  # Test: code@0edbee8 `tests/render-context-options.test.ts#L300` "records only the authored members: a built-in fallback or an unknown value is left out (Scenario 01a11e0e-42a3)". https://github.com/DevilTea/uiux/blob/0edbee80010fb87d3bd052e109605606a3e40cbe/tests/render-context-options.test.ts#L300
  # Test: code@0edbee8 `tests/render-context-browser.test.ts#L93` "records the Preview's Locale, viewport and theme on a comment on the whole View, and a Workbench re-anchor keeps it". https://github.com/DevilTea/uiux/blob/0edbee80010fb87d3bd052e109605606a3e40cbe/tests/render-context-browser.test.ts#L93
  # Test: code@0edbee8 `tests/canvas-comment-requests.test.ts#L13` "sends the captured render context with a new thread, Root ("Comment on this View") included". https://github.com/DevilTea/uiux/blob/0edbee80010fb87d3bd052e109605606a3e40cbe/tests/canvas-comment-requests.test.ts#L13
  # Status: built as of 0edbee8: the canvas composer records the Preview's Workspace-local Locale, viewport and theme, a comment on the whole View included, and no render context when none qualifies; the write-time key check of 01a11e0d-d2d0-7b31-9534-fd0fd6b8ca7c is built (PR #151).
  @spec:id:01a11e0e-42a3-7fc3-8205-f3d1452b2b8c
  @spec:demonstrates:01a1170f-c0ce-70ba-a94b-ff3cf24c38b0
  @spec:demonstrates:01a11e0d-d2d0-7b31-9534-fd0fd6b8ca7c
  Scenario: A canvas comment records only the authored render context keys
    Given a Workspace with Locale files for `en-US` and `zh-TW`, the viewport `mobile` in its Workspace settings and no theme
    Given a Reviewer previews one of its Views in `zh-TW`, the `mobile` viewport and the built-in `light` theme
    When the Reviewer comments on a Widget on the canvas
    Then the new thread records the Locale `zh-TW` and the viewport `mobile`
    Then the thread records no theme
