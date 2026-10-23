Feature: A failed automatic recovery attempt leaves Preview unavailable until Retry Preview
  # Source: issue #101 (https://github.com/DevilTea/uiux/issues/101), re-scoped on 2026-10-23 (https://github.com/DevilTea/uiux/issues/101#issuecomment-6357081429). Decisions behind the demonstrated Rules: #1 c139 d1 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651066; #1 c140 d2 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651108; #1 c141 d2 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651152; #2 c32 d3 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18655698.
  # Test: code@99f9d0e `tests/preview-failure-browser.test.ts#L341` "stops after the automatic attempt fails too: Preview stays unavailable with the selection kept, until Retry Preview (issue #101)". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/preview-failure-browser.test.ts#L341
  # Test: code@99f9d0e `tests/preview-failure-browser.test.ts#L372` "turns a press after a stalled automatic attempt into an explicit retry (issue #101)". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/preview-failure-browser.test.ts#L372
  # Test: code@99f9d0e `tests/preview-protocol-bridge.test.ts#L423` "exhausts recovery when the automatic attempt's document is found invalid before it declares". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/preview-protocol-bridge.test.ts#L423
  # Test: code@99f9d0e `tests/preview-protocol-session.test.ts#L212` "counts a protocol-invalid document with no admitted generation against the allowance". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/preview-protocol-session.test.ts#L212
  # Status: built as of 99f9d0e.
  @spec:id:01a16764-a1db-7f79-926b-72b5079340bd
  @spec:demonstrates:01a1161c-3c0e-7274-8112-db507455e0f4
  @spec:demonstrates:01a11658-1854-7e13-9089-a3fe4c53a33d
  @spec:demonstrates:01a11687-386c-764f-98fd-cf19dc3d0013
  Scenario: A failed automatic recovery attempt leaves Preview unavailable until Retry Preview
    Given the Workbench started the automatic recovery attempt after a protocol-invalid generation
    When the attempt's Preview document sends an undecodable capability declaration
    Then Preview stays capability-unavailable and no further Preview document is requested
    Then the structural Widget selection is kept
    Then Retry Preview is enabled, and activating it admits the next declared generation as an explicit retry
