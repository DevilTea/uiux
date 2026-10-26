Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 5 https://github.com/DevilTea/uiux/discussions/131; #131 body: decision 7 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Test: code@c704da6 `tests/preview-dom-geometry.test.ts#L1181` "states translucent coverage for paint proven over the Widget, keeps every covered pixel and cuts none of it as opaque". https://github.com/DevilTea/uiux/blob/c704da65fb1c9f96bde660711691a0d1cf79ee90/tests/preview-dom-geometry.test.ts#L1181
  # Test: code@c704da6 `tests/region-status-browser.test.ts#L94` "shows one notice beside the highlight and one marker on the Checks entry, follows the coverage, and adds no finding". https://github.com/DevilTea/uiux/blob/c704da65fb1c9f96bde660711691a0d1cf79ee90/tests/region-status-browser.test.ts#L94
  # Test: code@c704da6 `tests/region-status-browser.test.ts#L136` "hides the notice and the marker in comment mode and shows them again from fresh geometry". https://github.com/DevilTea/uiux/blob/c704da65fb1c9f96bde660711691a0d1cf79ee90/tests/region-status-browser.test.ts#L136
  # Note: The browser test opens the View page with the Widget selected by its address and puts the coverage into the Preview document; the marker row is a finding on the Widget that the test adds to the Workbench's own read of the View.
  # Status: built as of c704da6 (issue #106).
  @spec:id:01a11a5b-59cd-73a2-9dc7-8071f45f23ae
  @spec:demonstrates:01a11658-1d29-793c-9641-264dc477cfd5
  @spec:demonstrates:01a11687-3190-7ddd-afc2-6b2fb591f53d
  @spec:demonstrates:01a11a59-dbda-79e5-9337-307bb9c1798b
  Scenario: A translucently covered target shows one notice and one Checks marker
    Given a Widget lies under a translucent overlay that leaves it discernible
    Given the Preview runtime declares region-status support
    When a Reviewer opens that Widget from its View page's Checks panel
    Then the Workbench highlights the covered area of the Widget
    Then it shows one translucent-obstruction notice beside the highlight and one marker on the Widget's Checks entry
