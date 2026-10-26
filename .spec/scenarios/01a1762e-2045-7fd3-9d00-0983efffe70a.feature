Feature: Visible Widget geometry
  # Source: issue #110 (https://github.com/DevilTea/uiux/issues/110). Decisions behind the demonstrated Rules and Clauses: #1 c103 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18631231; #1 c105 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18631956; #1 c110 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18632599.
  # Test: code@7eceb6a `tests/contour-refinement-browser.test.ts#L147` "draws at the fit scale without contour work, refines when a zoom makes a contour miss the tolerance, and restores on scale-down". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/contour-refinement-browser.test.ts#L147
  # Test: code@7eceb6a `tests/preview-contour-refinement.test.ts#L115` "requests finer contours of only the failing regions for the unchanged geometry". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/preview-contour-refinement.test.ts#L115
  # Test: code@7eceb6a `tests/preview-contour-refinement.test.ts#L131` "restores the highlight only from a result that meets the tolerance, merging per region at once". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/preview-contour-refinement.test.ts#L131
  # Status: built as of 7eceb6a.
  @spec:id:01a1762e-2045-7948-b91a-50c7b7c9199a
  @spec:demonstrates:01a11687-32da-7ea6-83aa-d7451aaf0111
  @spec:demonstrates:01a11687-331e-7b04-98ad-f9f949eebd65
  @spec:demonstrates:01a11687-3366-7961-bb45-c04df9b1fb40
  Scenario: A zoom that makes a contour miss the display tolerance hides the highlight until finer contours arrive
    Given a Widget is selected and its cached contours meet the display tolerance at the current scale
    When the canvas zoom changes so that a contour of the Widget no longer meets the display tolerance
    Then the Workbench hides the whole highlight
    Then the Workbench requests finer contours of only the regions that miss the tolerance, for the unchanged geometry
    Then the highlight returns only from a result that meets the tolerance
