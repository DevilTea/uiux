Feature: Visible Widget geometry
  # Source: Discussion #2 comment 13 decisions 1-3 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18654000 and Discussion #1 comments 94 and 95 (only proven zero contribution cuts, nothing is guessed) https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18622872; owner ruling 2026-10-07 (spec import batch 6c): the accepted decisions win over the runtime's approximations of unmodelled paint. Issue #112 https://github.com/DevilTea/uiux/issues/112.
  # Test: code@869893d `tests/preview-dom-geometry.test.ts#L470` "cuts the paint of an exactly cut occluder that lies beyond its box: shadows, outlines, generated content, overflowing text, markers (#112)". https://github.com/DevilTea/uiux/blob/869893d20f91514778e0841b21dbd70033394a62/tests/preview-dom-geometry.test.ts#L470
  # Test: code@869893d `tests/preview-dom-geometry.test.ts#L533` "reaches the paint of an element whose text, generated content or marker leaves a box that does not overlap the Widget (#112)". https://github.com/DevilTea/uiux/blob/869893d20f91514778e0841b21dbd70033394a62/tests/preview-dom-geometry.test.ts#L533
  # Status: built as of 869893d.
  @spec:id:01a174ab-897e-766b-ab10-78550d12927c
  @spec:demonstrates:01a11687-314d-761f-b0a2-a565f419b8ea
  @spec:demonstrates:01a11687-3214-75af-84e6-befd07db432d
  Scenario: Paint beyond an opaque occluder's box still covers the Widget
    Given a Widget beside an opaque occluder with an outer box shadow, an outline, a positioned pseudo-element or text overflowing its box
    When the Preview measures the Widget's visible region
    Then the reported region leaves out the finite paint bound of that paint as well
    Then no pixel of the shadow, the outline, the pseudo-element or the text lies inside the reported region
