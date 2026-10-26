Feature: Visible Widget geometry
  # Source: Discussion #4 comment 4 decisions 1-3, the first-version baselines: opaque rectangles and border-radius boxes use their actual geometry, `inset()`, `circle()`, `ellipse()` and `polygon()` clip paths and geometric SVG `clipPath` take part when derivable https://github.com/DevilTea/uiux/discussions/4#discussioncomment-18656164. Issue #112 https://github.com/DevilTea/uiux/issues/112.
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L337` "cuts rounded, clip-path and SVG clip-path occluders by their actual shape (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L337
  # Test: code@11379d9 `tests/preview-clip-shapes.test.ts#L135` "derives circle, ellipse and inset shapes on either side of the true shape within their maxError". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-clip-shapes.test.ts#L135
  # Test: code@11379d9 `tests/preview-clip-shapes.test.ts#L179` "maps SVG clip primitives through the unit mapping, a circle becoming an ellipse under bounding-box units". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-clip-shapes.test.ts#L179
  # Status: built as of 11379d9.
  @spec:id:01a174ab-8872-75d9-9d8d-7eebe0b6134d
  @spec:demonstrates:01a11687-3109-7167-9c26-6e51c659d533
  @spec:demonstrates:01a11687-3297-7504-9206-92cb35788aaf
  Scenario: A clip path or an SVG clip path cuts the Widget by its shape, not by the occluder's box
    Given a Widget partly covered by an opaque occluder with a circle, a polygon or an SVG clip path
    When the Preview measures the Widget's visible region
    Then the reported region leaves out the clipped shape and no pixel the occluder paints
    Then the area the clip path leaves uncovered stays in the reported region
