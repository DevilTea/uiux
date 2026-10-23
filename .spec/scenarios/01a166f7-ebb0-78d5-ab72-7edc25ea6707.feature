Feature: Retry Preview after a capability failure spends one explicit retry
  # Source: issue #111 (https://github.com/DevilTea/uiux/issues/111); the explicit-retry slice moved there from issue #101 (https://github.com/DevilTea/uiux/issues/101#issuecomment-6357081429). Decisions behind the demonstrated Rules: #2 c15 d2 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18654094; #2 c32 d3 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18655698; #1 c143 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651432; #1 c144 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651512.
  # Test: code@1b1b64c `tests/preview-failure-browser.test.ts#L134` "shows a capability failure inline, and Retry Preview recovers through one explicit retry", whose second part activates Retry Preview three times while the retry's declaration is held, then lets the retry stall and reloads it under the same authorization. https://github.com/DevilTea/uiux/blob/1b1b64c95211a1aaee8ca0c5433f311e4f9f2624/tests/preview-failure-browser.test.ts#L134
  # Test: code@1b1b64c `tests/preview-protocol-bridge.test.ts#L380` "admits the next declared generation as the authorized retry and reopens Preview". https://github.com/DevilTea/uiux/blob/1b1b64c95211a1aaee8ca0c5433f311e4f9f2624/tests/preview-protocol-bridge.test.ts#L380
  # Test: code@1b1b64c `tests/preview-protocol-session.test.ts#L168` "admits a declared generation as the explicit retry only while an authorization is pending (issue #111)". https://github.com/DevilTea/uiux/blob/1b1b64c95211a1aaee8ca0c5433f311e4f9f2624/tests/preview-protocol-session.test.ts#L168
  # Status: built as of 1b1b64c for the exhausted-recovery path it shows; see the Implementation gaps entry of 01a11687-386c-764f-98fd-cf19dc3d0013 in its owner.
  @spec:id:01a166f7-ebb0-75cf-9307-982b0c025c6a
  @spec:demonstrates:01a1161c-3cf8-7859-9de8-2b99d22ce8aa
  @spec:demonstrates:01a1161c-3dad-7ac1-b49b-a77fcb1e33f2
  @spec:demonstrates:01a11687-386c-764f-98fd-cf19dc3d0013
  @spec:demonstrates:01a11687-38b0-706c-9cf7-613152b11492
  Scenario: Retry Preview after a capability failure spends one explicit retry
    Given Preview is unavailable because a capability failure exhausted recovery, and its inline diagnostic offers Retry Preview
    When Retry Preview is activated twice before the new generation declares its capabilities
    Then the Workbench requests exactly one fresh Preview document
    Then Retry Preview stays disabled while that retry is in its handshake
    Then the compatible generation that document declares is admitted as the explicit retry and Preview recovers
