Feature: Visible Widget geometry
  # Source: Discussion #4 comment 4 decisions 1-3, the first-version baselines: opaque rectangles and border-radius boxes use their actual geometry, `inset()`, `circle()`, `ellipse()` and `polygon()` clip paths and geometric SVG `clipPath` take part when derivable https://github.com/DevilTea/uiux/discussions/4#discussioncomment-18656164. Issue #112 https://github.com/DevilTea/uiux/issues/112.
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L386` "combines a rounded Widget, rounded clips and cuts, and clips the Widget by its own clip path (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L386
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L410` "clips a rounded Widget by a rounded overflow clip and by a clip path on an ancestor (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L410
  # Test: code@11379d9 `tests/preview-dom-geometry.test.ts#L455` "keeps failing closed for a mask, an underivable clip path and two curved clips on the Widget's own chain (#112)". https://github.com/DevilTea/uiux/blob/11379d9b021fbed04b551b3e071881cc1cd6b83a/tests/preview-dom-geometry.test.ts#L455
  # Status: built as of 11379d9.
  @spec:id:01a174ab-88f4-7990-ad5b-df0659e73369
  @spec:demonstrates:01a11687-3297-7504-9206-92cb35788aaf
  Scenario: A rounded shape or a clip path on the Widget's own chain limits what it reports
    Given a Widget whose border radius, a rounded overflow clip or a clip path on its chain cuts its corners
    When the Preview measures the Widget's visible region
    Then the reported region lies inside the shape that remains after every such clip
    Then the region carries the largest maxError of the shapes it combines
