Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 5 https://github.com/DevilTea/uiux/discussions/131; #131 body: decision 7 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Test: code@c704da6 `tests/preview-dom-geometry.test.ts#L1259` "states unavailable, with no region, when the visible region cannot be established". https://github.com/DevilTea/uiux/blob/c704da65fb1c9f96bde660711691a0d1cf79ee90/tests/preview-dom-geometry.test.ts#L1259
  # Test: code@c704da6 `tests/region-status-browser.test.ts#L157` "says that precise highlighting is unavailable for a region that cannot be established, and not that the Widget is not visible". https://github.com/DevilTea/uiux/blob/c704da65fb1c9f96bde660711691a0d1cf79ee90/tests/region-status-browser.test.ts#L157
  # Status: built as of c704da6 (issue #106).
  @spec:id:01a11a5b-5cf8-744f-9a1b-bbdfe4b9e364
  @spec:demonstrates:01a11658-2b13-76fd-a5e7-88542b59b08a
  @spec:demonstrates:01a11687-2d04-704b-887a-4b599e54e887
  @spec:demonstrates:01a11687-3256-7814-b6a7-2ab2591d9e72
  @spec:demonstrates:01a11a59-dbda-79e5-9337-307bb9c1798b
  Scenario: An unavailable region status reads as precise highlighting unavailable, not as not visible
    Given a Widget whose ancestor applies a CSS filter that the Preview cannot prove
    Given the Preview runtime declares region-status support
    When a Reviewer opens that Widget from Checks
    Then the geometry report carries no region and the unavailable status
    Then the Workbench keeps the Widget selected, draws no highlight and says that precise highlighting is unavailable
