Feature: Retry Preview after a capability failure spends one explicit retry
  # Source: issue #111 (https://github.com/DevilTea/uiux/issues/111); the explicit-retry slice moved there from issue #101 (https://github.com/DevilTea/uiux/issues/101#issuecomment-6357081429). Decisions behind the demonstrated Rules: #2 c15 d2 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18654094; #2 c32 d3 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18655698; #1 c143 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651432; #1 c144 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651512.
  # Test: code@c15227e `tests/preview-failure-browser.test.ts#L138` "shows a capability failure inline, and Retry Preview recovers through one explicit retry", whose second part activates Retry Preview three times while the retry's declaration is held. https://github.com/DevilTea/uiux/blob/c15227ed7777cda6a979a8b5f212b905aac5f255/tests/preview-failure-browser.test.ts#L138
  # Test: code@c15227e `tests/preview-failure-browser.test.ts#L201` "offers Retry Preview again when the retry stalls, even on an unreadable error page, and reloads under the same authorization". https://github.com/DevilTea/uiux/blob/c15227ed7777cda6a979a8b5f212b905aac5f255/tests/preview-failure-browser.test.ts#L201
  # Test: code@c15227e `tests/preview-protocol-bridge.test.ts#L380` "admits the next declared generation as the authorized retry and reopens Preview". https://github.com/DevilTea/uiux/blob/c15227ed7777cda6a979a8b5f212b905aac5f255/tests/preview-protocol-bridge.test.ts#L380
  # Test: code@c15227e `tests/preview-protocol-session.test.ts#L168` "admits a declared generation as the explicit retry only while an authorization is pending (issue #111)". https://github.com/DevilTea/uiux/blob/c15227ed7777cda6a979a8b5f212b905aac5f255/tests/preview-protocol-session.test.ts#L168
  # Status: built as of c15227e; 01a11687-386c-764f-98fd-cf19dc3d0013 built as of d6b576c, once the Workbench drove the automatic recovery itself (issue #101).
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
