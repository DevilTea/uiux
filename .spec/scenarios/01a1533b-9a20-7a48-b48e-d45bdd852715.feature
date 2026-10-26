Feature: Visible Widget geometry
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R6: paint without a finite bound stays fail-closed https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Test: code@081ce65 `tests/preview-dom-geometry.test.ts#L346` "still fails closed for occluder paint without a finite bound". https://github.com/DevilTea/uiux/blob/081ce65e2ee9041310e34f0f1e1fb5714b93c569/tests/preview-dom-geometry.test.ts#L346
  # Status: built as of 081ce65 for paint without a finite bound; the report does not yet say that the region is unavailable rather than empty (01a11687-3256-7814-b6a7-2ab2591d9e72); see its Implementation gaps entry in the owner.
  @spec:id:01a1533b-9a1f-7179-8f92-1081509ec067
  @spec:demonstrates:01a11687-3214-75af-84e6-befd07db432d
  Scenario: Occluder paint without a finite bound leaves no precise region
    Given a Widget partly covered by an element whose SVG filter has no finite bound
    When the Preview measures the Widget's visible region
    Then the Preview reports no precise visible region for the Widget
