Feature: The Workbench starts one automatic recovery attempt after a protocol-invalid generation
  # Source: issue #101 (https://github.com/DevilTea/uiux/issues/101), re-scoped on 2026-10-23 (https://github.com/DevilTea/uiux/issues/101#issuecomment-6357081429). Decisions behind the demonstrated Rules: #1 c138 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18650994; #1 c139 d1 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651066; the shared in-flight state: owner ruling 2 of 2026-10-23 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19138451; which failures start the attempt: owner ruling 3 of 2026-10-23 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19141069.
  # Test: code@99f9d0e `tests/preview-failure-browser.test.ts#L285` "after a capability conflict, the Workbench starts one automatic recovery attempt with the in-flight state of Retry Preview (issue #101)". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/preview-failure-browser.test.ts#L285
  # Test: code@99f9d0e `tests/preview-failure-browser.test.ts#L317` "never charges the automatic attempt for a malformed envelope the failed document sends after its conflict (issue #101)". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/preview-failure-browser.test.ts#L317
  # Test: code@99f9d0e `tests/preview-protocol-bridge.test.ts#L413` "admits the declared generation after a capability conflict as the automatic recovery the Workbench started (issue #101)". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/preview-protocol-bridge.test.ts#L413
  # Test: code@99f9d0e `tests/preview-protocol-session.test.ts#L187` "starts the one automatic recovery attempt on request and admits the next declared generation as it (issue #101)". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/preview-protocol-session.test.ts#L187
  # Status: built as of 99f9d0e.
  @spec:id:01a16764-8544-7061-a8ca-5347ee34957a
  @spec:demonstrates:01a1161c-3b93-74e5-993b-421a783a256d
  @spec:demonstrates:01a1161c-3bd4-7a91-b50e-d01a857521e5
  Scenario: The Workbench starts one automatic recovery attempt after a protocol-invalid generation
    Given Preview is open on a generation whose runtime then declares a conflicting capability set
    When the Workbench fails that generation as protocol-invalid
    Then the Workbench requests exactly one fresh Preview document in the same Preview session, without any user action
    Then the compatible generation that document declares is admitted and Preview recovers
