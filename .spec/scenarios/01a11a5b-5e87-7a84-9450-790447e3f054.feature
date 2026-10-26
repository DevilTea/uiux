Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 4 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Status: built as of a5f586e (issue #105, https://github.com/DevilTea/uiux/pull/362): the Workbench now tests the reported rectangle before the region set (`app/composables/usePreviewSession.ts`, `reportVisibility`).
  # Test: code@a5f586e `tests/preview-reveal.test.ts#L64` "sends nothing for a runtime that did not declare the feature". https://github.com/DevilTea/uiux/blob/a5f586e6854e785f71ed1fe7a08bed9759d59e5d/tests/preview-reveal.test.ts#L64
  # Test: code@a5f586e `tests/geometry-reveal-browser.test.ts#L165` "does not scroll for a Widget selected by the address, and says that it is outside the visible area". https://github.com/DevilTea/uiux/blob/a5f586e6854e785f71ed1fe7a08bed9759d59e5d/tests/geometry-reveal-browser.test.ts#L165
  # Note: The browser test runs against a Preview that declares reveal and selects the Widget by its address, which is no Checks navigation, so it shows the outside-the-visible-area text for a rendered Widget below the viewport; no test runs a Preview that declares none of the features.
  @spec:id:01a11a5b-5e86-760f-be95-353cfa1da3ab
  @spec:demonstrates:01a11a59-d8be-78aa-bdc7-28aa62bd9444
  @spec:demonstrates:01a11a59-eba4-7d32-a10e-1241b5337460
  Scenario: Without reveal support an offscreen navigation target is shown outside the visible area
    Given the Preview runtime declares none of the reveal, region-status and failure-report features
    Given a rendered Widget lies wholly below the Preview viewport
    When a Reviewer opens that Widget from Checks
    Then the Workbench sends no reveal and the Preview does not scroll
    Then the Workbench keeps the Widget selected and says that it is outside the visible area
