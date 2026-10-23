Feature: Reconnecting to a restarted server starts a new Preview session
  # Source: issue #101 (https://github.com/DevilTea/uiux/issues/101). Decision behind the demonstrated Rule: #1 c130 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18649978; the restart signal is the `hello` field `serverInstanceId`: #241 ruling 3 of 2026-10-20 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19070362.
  # Test: code@d6b576c `tests/preview-session-renewal-browser.test.ts#L45` "starts a new Preview session, with a fresh generation and newly acquired geometry, when the server restarted". https://github.com/DevilTea/uiux/blob/d6b576cd346264764064ebc9398a69dceef6100f/tests/preview-session-renewal-browser.test.ts#L45
  # Test: code@d6b576c `tests/live-events-client.test.ts#L129` "reports a server restart once, when a hello names another server instance, before its resync (issue #101)". https://github.com/DevilTea/uiux/blob/d6b576cd346264764064ebc9398a69dceef6100f/tests/live-events-client.test.ts#L129
  # Status: built as of d6b576c; comparison frames renew the same way, without a browser test of their own.
  @spec:id:01a16764-bf0f-7c55-bb66-fa8a4c5ae6ef
  @spec:demonstrates:01a1161c-3b51-7ebd-bff2-987863a7c1cb
  Scenario: Reconnecting to a restarted server starts a new Preview session
    Given a Workbench page shows Preview in an open Preview session with a Widget selected
    When the server restarts and the page's change-event stream reconnects to the new server instance
    Then the Workbench starts a new Preview session under a fresh session ID with a fresh Preview document
    Then the new document's first protocol message is the capability acknowledgement of its new generation
    Then the selected Widget's geometry is acquired again under the new session and generation
