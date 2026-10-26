Feature: Reconnecting to a restarted server starts a new Preview session
  # Source: issue #101 (https://github.com/DevilTea/uiux/issues/101). Decision behind the demonstrated Rule: #1 c130 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18649978; the restart signal is the `hello` field `serverInstanceId`: #241 ruling 3 of 2026-10-20 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19070362, and the Workbench detects the restart from it only: owner ruling 2 of 2026-10-23 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19141069.
  # Test: code@99f9d0e `tests/preview-session-renewal-browser.test.ts#L45` "starts a new Preview session, with a fresh generation and newly acquired geometry, when the server restarted". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/preview-session-renewal-browser.test.ts#L45
  # Test: code@99f9d0e `tests/live-events-client.test.ts#L129` "reports a server restart once, when a hello names another server instance, before its resync (issue #101)". https://github.com/DevilTea/uiux/blob/99f9d0e7d6b9dfb9aed17b6b1a995f7e7f301021/tests/live-events-client.test.ts#L129
  # Status: built as of 99f9d0e for the restart it shows, detected from the stream's `hello`; comparison frames renew the same way, without a browser test of their own. A restart during polling fallback or before the first `hello` is not detected: see the Implementation gaps entry of 01a1161c-3b51-7ebd-bff2-987863a7c1cb in its owner (issue #317).
  @spec:id:01a16764-bf0f-7c55-bb66-fa8a4c5ae6ef
  @spec:demonstrates:01a1161c-3b51-7ebd-bff2-987863a7c1cb
  @spec:demonstrates:01a175ec-c8cb-7cf3-bc94-1168ed11e3a9
  Scenario: Reconnecting to a restarted server starts a new Preview session
    Given a Workbench page shows Preview in an open Preview session with a Widget selected
    When the server restarts and the page next reads an API response or receives a hello that names the new server instance ID
    Then the Workbench starts a new Preview session under a fresh session ID with a fresh Preview document
    Then the new document's first protocol message is the capability acknowledgement of its new generation
    Then the selected Widget's geometry is acquired again under the new session and generation
