Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 2 https://github.com/DevilTea/uiux/discussions/131; #131 body: decision 3 https://github.com/DevilTea/uiux/discussions/131; #131 body: decision 4 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Status: built as of a5f586e (issue #105, https://github.com/DevilTea/uiux/pull/362); the Implementation gaps entry of 01a11a59-da48-7437-bee8-67787175cbda records one difference, for a reveal that reaches a document before it has rendered.
  # Test: code@a5f586e `tests/preview-reveal-browser.test.ts#L89` "scrolls only the nearest scroll container when that is enough". https://github.com/DevilTea/uiux/blob/a5f586e6854e785f71ed1fe7a08bed9759d59e5d/tests/preview-reveal-browser.test.ts#L89
  # Test: code@a5f586e `tests/preview-reveal-browser.test.ts#L100` "scrolls the container and then the root scroller when the container itself is offscreen". https://github.com/DevilTea/uiux/blob/a5f586e6854e785f71ed1fe7a08bed9759d59e5d/tests/preview-reveal-browser.test.ts#L100
  # Test: code@a5f586e `tests/geometry-reveal-browser.test.ts#L117` "scrolls the Preview to it, highlights it, and asks once on the stream it opened (Rule 01a11a59-e876-780b-832c-0a139baabc95)". https://github.com/DevilTea/uiux/blob/a5f586e6854e785f71ed1fe7a08bed9759d59e5d/tests/geometry-reveal-browser.test.ts#L117
  # Note: The Checks navigation of the last test is Overview > Checks to a Widget below the fold of the Mobile viewport in a root scroller; the nested scroll containers are tested on the runtime's scroll alone, in plain documents.
  @spec:id:01a11a5b-5395-729b-845b-d72eb5d82032
  @spec:demonstrates:01a11658-1b52-7f00-8f9d-eaf580c29253
  @spec:demonstrates:01a11a59-da48-7437-bee8-67787175cbda
  @spec:demonstrates:01a11a59-e876-780b-832c-0a139baabc95
  @spec:demonstrates:01a11a70-3d8d-7e52-9412-8a92797814e6
  Scenario: A Checks navigation scrolls a target out of view in a nested scroll container into view
    Given a View whose Widget is scrolled out of view inside a nested scroll container of the Preview
    Given the Preview runtime declares reveal support
    When a Reviewer opens that Widget from Checks
    Then the Preview scrolls only its own scroll containers until the Widget is in view
    Then the Workbench highlights the Widget from the geometry report that follows the scroll
