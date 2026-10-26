Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 4 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Status: built as of a5f586e (issue #105, https://github.com/DevilTea/uiux/pull/362): a reveal request exists only for a Checks navigation and is dropped by every other selection (`app/composables/usePreviewSession.ts`, `selectWidget`).
  # Test: code@a5f586e `tests/preview-reveal.test.ts#L90` "is never sent by stream lifecycle: reopening, superseding and a context change open streams without a reveal". https://github.com/DevilTea/uiux/blob/a5f586e6854e785f71ed1fe7a08bed9759d59e5d/tests/preview-reveal.test.ts#L90
  # Test: code@a5f586e `tests/geometry-reveal-browser.test.ts#L180` "does not scroll for a selection in the Widget tree after a Checks navigation". https://github.com/DevilTea/uiux/blob/a5f586e6854e785f71ed1fe7a08bed9759d59e5d/tests/geometry-reveal-browser.test.ts#L180
  # Note: No test enters and leaves comment mode: the View page's Checks panel lists only the findings of a View that cannot render, so no Widget of it is rendered.
  @spec:id:01a11a5b-5841-7f1d-9c16-6d05a3c10c3f
  @spec:demonstrates:01a11a59-ea08-74ff-8a88-6e70b4fa3a84
  Scenario: A highlight restored after comment mode never scrolls the Preview
    Given the Preview runtime declares reveal support
    Given comment mode suspends the Checks highlight of a Widget
    Given the Reviewer has scrolled the Preview until that Widget left the viewport
    When the Reviewer leaves comment mode
    Then the Preview does not scroll
    Then the Widget stays selected
