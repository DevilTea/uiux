Feature: Review desk
  # Source: Discussion #7 owner rulings 2026-10-09, ruling 3: Part 7 Scenarios for capture, the inbox link, the stale-key fallback, muted-pin activation and migration https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18820343; #7 c11 decision 2 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18797092; ruling 2: only Workspace-authored keys are recorded https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18820343.
  # Status: not built as of 11f8b7b; see the Implementation gaps entries of 01a1170f-c0ce-70ba-a94b-ff3cf24c38b0 and 01a11e0d-d2d0-7b31-9534-fd0fd6b8ca7c in their owners.
  # Note: No test exists yet; tracked in issue #144.
  @spec:id:01a11e0e-42a3-7fc3-8205-f3d1452b2b8c
  @spec:demonstrates:01a1170f-c0ce-70ba-a94b-ff3cf24c38b0
  @spec:demonstrates:01a11e0d-d2d0-7b31-9534-fd0fd6b8ca7c
  Scenario: A canvas comment records only the authored render context keys
    Given a Workspace with Locale files for `en-US` and `zh-TW`, the viewport `mobile` in its registry and no theme
    Given a Reviewer previews one of its Views in `zh-TW`, the `mobile` viewport and the built-in `light` theme
    When the Reviewer comments on a Widget on the canvas
    Then the new thread records the Locale `zh-TW` and the viewport `mobile`
    Then the thread records no theme
