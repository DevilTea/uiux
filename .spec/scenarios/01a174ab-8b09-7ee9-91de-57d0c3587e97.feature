Feature: Visible Widget geometry
  # Source: Discussion #2 comment 13 decisions 1-3 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18654000 and Discussion #1 comments 94 and 95 (only proven zero contribution cuts, nothing is guessed) https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18622872; owner ruling 2026-10-07 (spec import batch 6c): the accepted decisions win over the runtime's approximations of unmodelled paint. Issue #112 https://github.com/DevilTea/uiux/issues/112.
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L439` "accounts for the backdrop of a modal dialog over a Widget outside it (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L439
  # Status: built as of 11379d9 for the cut; the report says that the region is unavailable rather than empty as of c704da6 (01a11687-3256-7814-b6a7-2ab2591d9e72, issue #106).
  @spec:id:01a174ab-8b09-7963-865c-a161d5c059ec
  @spec:demonstrates:01a11687-3214-75af-84e6-befd07db432d
  Scenario: An opaque backdrop of a modal dialog leaves no precise region for a Widget outside the dialog
    Given a modal dialog whose backdrop is opaque and a Widget outside the dialog
    When the Preview measures the Widget's visible region
    Then the Preview reports no precise visible region for the Widget
    Then a Widget inside the dialog keeps its region, since it paints above the backdrop
