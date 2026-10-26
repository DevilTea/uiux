Feature: Visible Widget geometry
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 5 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Test: code@c704da6 `tests/preview-region-status.test.ts#L98` "reports a change of the status alone as a new revision, and nothing while it holds". https://github.com/DevilTea/uiux/blob/c704da65fb1c9f96bde660711691a0d1cf79ee90/tests/preview-region-status.test.ts#L98
  # Test: code@c704da6 `tests/region-status-browser.test.ts#L94` "shows one notice beside the highlight and one marker on the Checks entry, follows the coverage, and adds no finding". https://github.com/DevilTea/uiux/blob/c704da65fb1c9f96bde660711691a0d1cf79ee90/tests/region-status-browser.test.ts#L94
  # Status: built as of c704da6 (issue #106): the stream reports a change of the status alone with an advanced revision, and the Workbench drops the notice and the marker with it.
  @spec:id:01a11a5b-5b60-7408-8a7b-acb621f9bd5e
  @spec:demonstrates:01a11658-1d6e-75b1-b5c7-118341164ff5
  @spec:demonstrates:01a11658-29fd-7a44-8e90-4da7cfe3d819
  Scenario: A change of coverage alone is reported as a new revision
    Given a Widget's geometry stream reports translucent coverage over it
    When the translucent overlay is removed without moving or resizing the Widget
    Then the stream reports the Widget again with an advanced revision and no region status
    Then the Workbench removes the translucent-obstruction notice
