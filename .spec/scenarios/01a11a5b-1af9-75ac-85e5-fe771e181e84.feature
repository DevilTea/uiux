Feature: Render context
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 8, R31 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Test: code@547ff0f `tests/adapter-theme-support-browser.test.ts#L103` "shows the render-context diagnostic in the Preview in place of the View, and renders again on a supported theme". https://github.com/DevilTea/uiux/blob/547ff0f6e758c64af4683f130e406ce436632adf/tests/adapter-theme-support-browser.test.ts#L103
  # Test: code@547ff0f `tests/adapter-theme-support-browser.test.ts#L132` "is refused by formal capture, while a supported theme captures". https://github.com/DevilTea/uiux/blob/547ff0f6e758c64af4683f130e406ce436632adf/tests/adapter-theme-support-browser.test.ts#L132
  # Test: code@547ff0f `tests/adapter-theme-support-browser.test.ts#L91` "is reported by the adapters route while the Adapter set stays valid". https://github.com/DevilTea/uiux/blob/547ff0f6e758c64af4683f130e406ce436632adf/tests/adapter-theme-support-browser.test.ts#L91
  # Test: code@547ff0f `tests/adapter-theme-support.test.ts#L215` "refuses that context with render_context.incompatible_theme before any browser runs, and stores nothing". https://github.com/DevilTea/uiux/blob/547ff0f6e758c64af4683f130e406ce436632adf/tests/adapter-theme-support.test.ts#L215
  # Status: built as of 547ff0f.
  @spec:id:01a11a5b-1af9-7359-bb53-add13edeb3be
  @spec:demonstrates:01a115cd-c27d-78ba-b95d-bf1aa50adec7
  @spec:demonstrates:01a11a5a-566b-70b1-b000-2918519c0d19
  @spec:demonstrates:01a11a5a-56e8-71c8-905a-62ed0476fd8f
  Scenario: An unsupported theme is diagnosed and its capture refused
    Given a Workspace with the themes `light` and `contrast` whose active Adapter supports only `light`
    When an author previews a View with the theme `contrast`
    When formal capture is requested for that View with the theme `contrast`
    When the author previews and formally captures the same View with the theme `light`
    Then the `contrast` Preview shows a render-context diagnostic in place of the View and never renders it with the `light` theme
    Then formal capture refuses the `contrast` context
    Then the View renders and is captured with the theme `light`
