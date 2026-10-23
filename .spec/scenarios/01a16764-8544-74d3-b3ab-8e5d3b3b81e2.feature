Feature: The Workbench starts one automatic recovery attempt after a protocol-invalid generation
  # Source: issue #101 (https://github.com/DevilTea/uiux/issues/101), re-scoped on 2026-10-23 (https://github.com/DevilTea/uiux/issues/101#issuecomment-6357081429). Decisions behind the demonstrated Rules: #1 c138 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18650994; #1 c139 d1 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651066; the shared in-flight state: owner ruling 2 of 2026-10-23 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19138451.
  # Test: code@d6b576c `tests/preview-failure-browser.test.ts#L285` "after a capability conflict, the Workbench starts one automatic recovery attempt with the in-flight state of Retry Preview (issue #101)". https://github.com/DevilTea/uiux/blob/d6b576cd346264764064ebc9398a69dceef6100f/tests/preview-failure-browser.test.ts#L285
  # Test: code@d6b576c `tests/preview-protocol-bridge.test.ts#L413` "admits the declared generation after a capability conflict as the automatic recovery the Workbench started (issue #101)". https://github.com/DevilTea/uiux/blob/d6b576cd346264764064ebc9398a69dceef6100f/tests/preview-protocol-bridge.test.ts#L413
  # Test: code@d6b576c `tests/preview-protocol-session.test.ts#L187` "starts the one automatic recovery attempt on request and admits the next declared generation as it (issue #101)". https://github.com/DevilTea/uiux/blob/d6b576cd346264764064ebc9398a69dceef6100f/tests/preview-protocol-session.test.ts#L187
  # Status: built as of d6b576c.
  @spec:id:01a16764-8544-7061-a8ca-5347ee34957a
  @spec:demonstrates:01a1161c-3b93-74e5-993b-421a783a256d
  @spec:demonstrates:01a1161c-3bd4-7a91-b50e-d01a857521e5
  Scenario: The Workbench starts one automatic recovery attempt after a protocol-invalid generation
    Given Preview is open on a generation whose runtime then declares a conflicting capability set
    When the Workbench fails that generation as protocol-invalid
    Then the Workbench requests exactly one fresh Preview document in the same Preview session, without any user action
    Then Retry Preview stays disabled while that attempt is in its handshake
    Then the compatible generation that document declares is admitted and Preview recovers
