Feature: Visible Widget geometry
  # Source: Discussion #241 owner decision 1 during the review of #259 (2026-10-19): a cut by an over-approximated finite bound that lies wholly inside the Widget would leave only an interior hole, which Rule 01a11687-3037 does not report, so the Widget gets no precise region; exactly cut occluders keep their behavior https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19036379.
  # Test: code@081ce65 `tests/preview-dom-geometry.test.ts#L471` "fails closed when a bounded cut would only leave an interior hole, and keeps exact cuts as they are". https://github.com/DevilTea/uiux/blob/081ce65e2ee9041310e34f0f1e1fb5714b93c569/tests/preview-dom-geometry.test.ts#L471
  # Status: built as of 081ce65 for an image wholly inside the visible area; the report does not yet say that the region is unavailable rather than empty (01a11687-3256-7814-b6a7-2ab2591d9e72); see its Implementation gaps entry in the owner.
  @spec:id:01a15373-ea4c-7e54-bf51-2a9fc2c4b277
  @spec:demonstrates:01a11687-3037-74fd-8a8a-0d365206c288
  @spec:demonstrates:01a11687-3214-75af-84e6-befd07db432d
  Scenario: An image wholly inside a Widget leaves no precise region
    Given a Widget with an image painted above it wholly inside its visible area
    When the Preview measures the Widget's visible region
    Then the Preview reports no precise visible region for the Widget
