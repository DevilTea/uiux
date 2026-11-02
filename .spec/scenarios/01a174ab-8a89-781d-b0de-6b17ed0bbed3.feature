Feature: Visible Widget geometry
  # Source: Discussion #2 comment 13 decisions 1-3 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18654000 and Discussion #1 comments 94 and 95 (only proven zero contribution cuts, nothing is guessed) https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18622872; owner ruling 2026-10-07 (spec import batch 6c): the accepted decisions win over the runtime's approximations of unmodelled paint. Issue #112 https://github.com/DevilTea/uiux/issues/112.
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L598` "selects paint without a finite bound wherever its clips allow, not only where its border box is (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L598
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L526` "bounds combining marks by the marks stacked on a letter, so text elsewhere keeps its Widgets and text over one is cut (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L526
  # Status: built as of 11379d9 for the cut and the selection; the report says that the region is unavailable rather than empty as of c704da6 (01a11687-3256-7814-b6a7-2ab2591d9e72, issue #106).
  @spec:id:01a174ab-8a89-7d51-aad6-a31058375d0a
  @spec:demonstrates:01a11687-3214-75af-84e6-befd07db432d
  Scenario: Paint without a finite bound anywhere its clips allow leaves no precise region
    Given a Widget and an element elsewhere in the View whose SVG filter or 3D transform has no finite bound
    When the Preview measures the Widget's visible region
    Then the Preview reports no precise visible region for the Widget
    Then an element whose clips keep that paint away from the Widget does not change its region
