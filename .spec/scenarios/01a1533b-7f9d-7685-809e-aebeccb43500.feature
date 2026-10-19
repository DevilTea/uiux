Feature: Visible Widget geometry
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R6: an occluder whose exact shape is unproven but whose paint has a finite bound is cut by an over-approximation of that bound, and what remains is still proven visible https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804. Issue #59 https://github.com/DevilTea/uiux/issues/59.
  # Test: code@6d23f9c `tests/preview-dom-geometry.test.ts#L224` "cuts an undecided in-flow overlap and an image above by their bound and keeps the rest (#59)". https://github.com/DevilTea/uiux/blob/6d23f9c3e66a7e93e02b10b6d66558540fdee8ea/tests/preview-dom-geometry.test.ts#L224
  # Test: code@6d23f9c `tests/preview-dom-geometry.test.ts#L239` "cuts occluders of unproven shape by their box: rounded corners, clip paths, SVG clip paths, masks, blend modes, SVG and native controls". https://github.com/DevilTea/uiux/blob/6d23f9c3e66a7e93e02b10b6d66558540fdee8ea/tests/preview-dom-geometry.test.ts#L239
  # Test: code@6d23f9c `tests/preview-dom-geometry.test.ts#L265` "grows the cut by filter extents, outer shadows and outlines, its own and its ancestors'". https://github.com/DevilTea/uiux/blob/6d23f9c3e66a7e93e02b10b6d66558540fdee8ea/tests/preview-dom-geometry.test.ts#L265
  # Status: built as of 6d23f9c.
  @spec:id:01a1533b-7f9d-73ab-9533-2ad47e94371b
  @spec:demonstrates:01a11687-3109-7167-9c26-6e51c659d533
  @spec:demonstrates:01a11687-314d-761f-b0a2-a565f419b8ea
  Scenario: A Widget partly covered by an image keeps its uncovered part
    Given a Widget whose corner is covered by an image painted above it
    When the Preview measures the Widget's visible region
    Then the reported region leaves out the image's box
    Then the rest of the Widget stays in the reported region
