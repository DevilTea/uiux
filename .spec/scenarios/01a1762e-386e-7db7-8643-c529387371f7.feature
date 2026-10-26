Feature: Visible Widget geometry
  # Source: issue #110 (https://github.com/DevilTea/uiux/issues/110). Decisions behind the demonstrated Rules and Clauses: #1 c107 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18632200; #2 c7 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18653456.
  # Test: code@7eceb6a `tests/contour-refinement-browser.test.ts#L174` "cancels pending work on a Variant switch and never commits its late response". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/contour-refinement-browser.test.ts#L174
  # Test: code@7eceb6a `tests/preview-contour-refinement.test.ts#L204` "cancels the work of the previous View or Variant, and ends it with the new context". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/preview-contour-refinement.test.ts#L204
  # Test: code@7eceb6a `tests/preview-contour-work.test.ts#L140` "honors a cancellation of waiting work only for its exact sequence". https://github.com/DevilTea/uiux/blob/7eceb6acec9a11455b2cbb3f9e6011989705bed0/tests/preview-contour-work.test.ts#L140
  # Status: built as of 7eceb6a.
  @spec:id:01a1762e-386e-710f-83b3-3d821e08d893
  @spec:demonstrates:01a11687-3d6e-79e8-8f1f-7934ece17ed6
  @spec:demonstrates:01a11687-403f-78cb-b625-b6e56d35ead0
  Scenario: Switching the Variant cancels pending contour work
    Given contour work is pending for the selected Widget
    When the Preview's render context changes to another Variant within the same runtime generation
    Then the Workbench sends a best-effort cancellation naming the pending work's sequence
    Then no response of that work ever commits
