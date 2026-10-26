Feature: Reconnecting to a restarted server starts a new Preview session
  # Source: issue #101 (https://github.com/DevilTea/uiux/issues/101) and issue #317 (https://github.com/DevilTea/uiux/issues/317). Decision behind the demonstrated Rule: #1 c130 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18649978; the restart signal is the server instance ID of an API response (`X-UIUX-Server-Instance`) or of the `hello` field `serverInstanceId`: #241 ruling 3 of 2026-10-20 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19070362, and owner ruling 4 of 2026-10-26 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19186750, which supersedes ruling 2 of 2026-10-23 ("only from hello").
  # Test: code@7e1227e `tests/preview-session-renewal-browser.test.ts#L45` "starts a new Preview session, with a fresh generation and newly acquired geometry, when the server restarted". https://github.com/DevilTea/uiux/blob/7e1227e3491703416e8049d4129a3e96a2ee2a64/tests/preview-session-renewal-browser.test.ts#L45
  # Test: code@7e1227e `tests/preview-session-renewal-browser.test.ts#L132` "starts a new Preview session when the server restarted while the Workbench polls in fallback". https://github.com/DevilTea/uiux/blob/7e1227e3491703416e8049d4129a3e96a2ee2a64/tests/preview-session-renewal-browser.test.ts#L132
  # Test: code@7e1227e `tests/preview-session-renewal-browser.test.ts#L144` "starts a new Preview session when the server restarted before the page received a first hello". https://github.com/DevilTea/uiux/blob/7e1227e3491703416e8049d4129a3e96a2ee2a64/tests/preview-session-renewal-browser.test.ts#L144
  # Test: code@7e1227e `tests/preview-session-renewal-browser.test.ts#L169` "keeps the Preview session while the server instance stays the same, and names the instance on a refusal". https://github.com/DevilTea/uiux/blob/7e1227e3491703416e8049d4129a3e96a2ee2a64/tests/preview-session-renewal-browser.test.ts#L169
  # Test: code@7e1227e `tests/live-events-client.test.ts#L162` "compares the server instance of every API response with the one seen before, and of hello with the same state (issue #317)". https://github.com/DevilTea/uiux/blob/7e1227e3491703416e8049d4129a3e96a2ee2a64/tests/live-events-client.test.ts#L162
  # Status: built as of 7e1227e; comparison frames renew the same way, without a browser test of their own.
  @spec:id:01a16764-bf0f-7c55-bb66-fa8a4c5ae6ef
  @spec:demonstrates:01a1161c-3b51-7ebd-bff2-987863a7c1cb
  @spec:demonstrates:01a175ec-c8cb-7cf3-bc94-1168ed11e3a9
  Scenario: Reconnecting to a restarted server starts a new Preview session
    Given a Workbench page shows Preview in an open Preview session with a Widget selected
    When the server restarts and the page next reads an API response or receives a hello that names the new server instance ID
    Then the Workbench starts a new Preview session under a fresh session ID with a fresh Preview document
    Then the new document's first protocol message is the capability acknowledgement of its new generation
    Then the selected Widget's geometry is acquired again under the new session and generation
