Feature: Visible Widget geometry
  # Source: Discussion #2 comment 13 decisions 1-3 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18654000 and Discussion #1 comments 94 and 95 (only proven zero contribution cuts, nothing is guessed) https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18622872; owner ruling 2026-10-07 (spec import batch 6c): the accepted decisions win over the runtime's approximations of unmodelled paint. Issue #112 https://github.com/DevilTea/uiux/issues/112.
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L470` "cuts the paint of an exactly cut occluder that lies beyond its box: shadows, outlines, generated content, overflowing text, markers (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L470
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L509` "keeps what a translucent fill and a translucent border let show, and cuts a solid border and text over it (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L509
  # Status: built as of 11379d9.
  @spec:id:01a174ab-8a03-77d9-81ec-f13bf4152eb8
  @spec:demonstrates:01a11687-3214-75af-84e6-befd07db432d
  Scenario: A solid opaque border without a fill covers only its four sides
    Given a Widget under an element that paints only a solid opaque border
    When the Preview measures the Widget's visible region
    Then the reported region leaves out the four sides of the border
    Then the area the border frames stays in the reported region as a piece of its own
