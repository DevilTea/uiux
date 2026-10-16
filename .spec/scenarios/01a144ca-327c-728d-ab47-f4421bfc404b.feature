Feature: Preview session and runtime lifecycle
  # Source: issue #136 https://github.com/DevilTea/uiux/issues/136. Decision behind the demonstrated Clause: #1 c126 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18647731.
  # Test: code@0877fe6 `tests/preview-protocol-bridge.test.ts#L201` "discards an undecodable message of the replaced generation during the new handshake". https://github.com/DevilTea/uiux/blob/0877fe63b039424c27e65d9fed2d0f55cfe36c83/tests/preview-protocol-bridge.test.ts#L201
  # Test: code@0877fe6 `tests/flows-browser.test.ts#L287` "ignores an undecodable message of the replaced generation during the next handshake". https://github.com/DevilTea/uiux/blob/0877fe63b039424c27e65d9fed2d0f55cfe36c83/tests/flows-browser.test.ts#L287
  # Status: built as of 0877fe6.
  @spec:id:01a144ca-327c-73cb-b287-d2681bf99265
  @spec:demonstrates:01a1161c-418f-799c-944d-23a1e17e4f19
  Scenario: A message of the replaced generation is discarded during the new handshake, even when it does not decode
    Given an acknowledged runtime generation
    Given a message of that generation whose `type` the Workbench does not know is in flight
    When the Workbench replaces the generation and the message arrives before the new generation's acknowledgement
    Then the Workbench discards the message as stale, without effect
    Then the new generation's handshake opens and the Preview session never shows as stopped
