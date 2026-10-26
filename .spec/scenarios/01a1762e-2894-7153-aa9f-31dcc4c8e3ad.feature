Feature: Visible Widget geometry
  # Source: issue #110 (https://github.com/DevilTea/uiux/issues/110). Decisions behind the demonstrated Rules and Clauses: #1 c107 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18632200; #1 c108 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18632299.
  # Test: code@7eceb6a `tests/preview-contour-refinement.test.ts#L147` "restores an accurate cache on scale-down at once, retiring and canceling the pending work". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/preview-contour-refinement.test.ts#L147
  # Test: code@7eceb6a `tests/contour-refinement-browser.test.ts#L147` "draws at the fit scale without contour work, refines when a zoom makes a contour miss the tolerance, and restores on scale-down". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/contour-refinement-browser.test.ts#L147
  # Status: built as of 7eceb6a.
  @spec:id:01a1762e-2894-7831-8b32-e0ffb2480cbe
  @spec:demonstrates:01a11687-3431-7067-9ede-746027543b03
  @spec:demonstrates:01a11687-3474-7773-b690-0cc1cc06f8ea
  @spec:demonstrates:01a11687-3d6e-79e8-8f1f-7934ece17ed6
  @spec:demonstrates:01a11687-403f-78cb-b625-b6e56d35ead0
  Scenario: A scale-down restores the cached highlight at once and cancels the pending refinement
    Given finer contours are pending because a zoom made a cached contour miss the display tolerance
    When the canvas zoom changes so that the cached contours meet the display tolerance again
    Then the Workbench draws the cached highlight at once and sends no further request
    Then the Workbench sends a best-effort cancellation naming the pending work
    Then a response of the retired work never commits
