Feature: Visible Widget geometry
  # Source: Discussion #4 comment 4 decisions 1-3, the first-version baselines: opaque rectangles and border-radius boxes use their actual geometry, `inset()`, `circle()`, `ellipse()` and `polygon()` clip paths and geometric SVG `clipPath` take part when derivable https://github.com/DevilTea/uiux/discussions/4#discussioncomment-18656164. Issue #112 https://github.com/DevilTea/uiux/issues/112.
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L337` "cuts rounded, clip-path and SVG clip-path occluders by their actual shape (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L337
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L376` "leaves the corners of a rounded occluder box visible (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L376
  # Test: code@11379d9 `tests/preview-clip-shapes.test.ts#L75` "contains a rounded rectangle, keeps its straight sides exact and bounds the corner error". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-clip-shapes.test.ts#L75
  # Status: built as of 11379d9.
  @spec:id:01a174ab-87e1-756e-afcf-6ff4c97eb55c
  @spec:demonstrates:01a11687-3109-7167-9c26-6e51c659d533
  @spec:demonstrates:01a11687-3297-7504-9206-92cb35788aaf
  Scenario: A Widget under a rounded occluder keeps the area outside its corners
    Given a Widget partly covered by an opaque occluder with rounded corners
    When the Preview measures the Widget's visible region
    Then the reported region leaves out the rounded shape and no pixel the occluder paints
    Then the area the rounded corners leave uncovered stays in the reported region
    Then the region carries a maxError that bounds its curved edge
