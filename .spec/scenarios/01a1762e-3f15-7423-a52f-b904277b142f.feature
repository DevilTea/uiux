Feature: Preview failure diagnostics
  # Source: issue #110 (https://github.com/DevilTea/uiux/issues/110). Decisions behind the demonstrated Rules and Clauses: #1 c118 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18637408; #1 c119 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18639061.
  # Test: code@7eceb6a `tests/contour-refinement-browser.test.ts#L232` "ends work on a work-scoped failure report and latches until the geometry or the context changes". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/contour-refinement-browser.test.ts#L232
  # Test: code@7eceb6a `tests/preview-contour-refinement.test.ts#L331` "is not cleared by scale changes, and a cache that meets the tolerance still draws". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/preview-contour-refinement.test.ts#L331
  # Status: built as of 7eceb6a.
  @spec:id:01a1762e-3f15-7b61-89a0-552ae35ea91b
  @spec:demonstrates:01a11687-3693-723e-8f71-82c431d79220
  @spec:demonstrates:01a11687-36d8-771c-ab58-2d564fd20f5b
  Scenario: Outer scale changes never clear the refinement latch
    Given refinement is latched by a work-scoped failure report within a geometry revision
    When the canvas zoom changes, up and down
    Then the Workbench starts no refinement and the latch stays
    Then cached contours that meet the display tolerance at the current scale are still drawn
    Then precise highlighting shows as unavailable again once they no longer do
