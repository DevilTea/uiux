Feature: A silent recovery document shows the Preview connection as lost
  # Source: issue #467 (https://github.com/DevilTea/uiux/issues/467); owner ruling 2026-11-02 in Discussion #379 https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19341847. Decisions behind the demonstrated Rules: #2 c31 d2 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18655634; #241 owner ruling 1 of 2026-10-23 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19138451.
  # Test: code@3ae6357 `tests/preview-failure-browser.test.ts#L400` "derives transport.channel_unavailable when the automatic attempt stalls, and a late declaration clears it only at its acknowledgement (issue #467)". https://github.com/DevilTea/uiux/blob/3ae6357066bed2fe7f2ec3e705b7383e26477269/tests/preview-failure-browser.test.ts#L400
  # Test: code@3ae6357 `tests/preview-failure-diagnostic.test.ts#L108` "derives transport.channel_unavailable, correlated with the session alone, once the automatic allowance is spent". https://github.com/DevilTea/uiux/blob/3ae6357066bed2fe7f2ec3e705b7383e26477269/tests/preview-failure-diagnostic.test.ts#L108
  # Status: built as of 3ae6357 (issue #467).
  @spec:id:01a19a12-349c-7475-a381-25a8a7cb3951
  @spec:demonstrates:01a19a11-f14c-7ca5-aa9d-d25b7390e914
  @spec:demonstrates:01a19a12-09c7-7c03-ba0f-3a61f2181076
  Scenario: A silent recovery document shows the Preview connection as lost
    Given the automatic recovery attempt was started after a protocol-invalid generation and its Preview document loaded
    When the document declares no capabilities within the grace period
    Then the Workbench shows the inline diagnostic of the `transport` category with the copy of the `transport.channel_unavailable` reason
    Then its technical details carry the Preview session identity and no generation identity
    Then a later declaration of that document is admitted as the recovery generation, and the diagnostic ends only when that generation completes its handshake
