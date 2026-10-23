Feature: A retired Preview session ID is never activated again
  # Source: issue #101 (https://github.com/DevilTea/uiux/issues/101). Decisions behind the demonstrated Rule: #1 c128 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18648137; #1 c129 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18649960; the process is the Workbench page: owner ruling 1 of 2026-10-23 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19141069.
  # Test: code@99f9d0e `tests/preview-protocol-session.test.ts#L283` "discards a minted session ID that is active or retired and mints another before the session begins (issue #101)". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/preview-protocol-session.test.ts#L283
  # Status: built as of 99f9d0e.
  @spec:id:01a16764-da63-7965-9d21-c46c558e57ae
  @spec:demonstrates:01a1161c-3b15-7913-acfb-136f0bd365b6
  Scenario: A retired Preview session ID is never activated again
    Given the Workbench retired a Preview session ID earlier in the same Workbench process
    When the Workbench mints that ID again for a new Preview session
    Then the Workbench discards that ID and mints another before the new Preview session begins
