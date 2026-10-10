Feature: Access and roster
  # Source: Discussion #174 (Part 16), Decisions: roster administration only from loopback and `https` origins; Security rationale: Administration; New Scenarios https://github.com/DevilTea/uiux/discussions/174; accepted as written 2026-10-10 https://github.com/DevilTea/uiux/discussions/174#discussioncomment-18848606.
  # Test: code@be5692f `tests/access-http.test.ts#L205` "refuses roster administration on an http origin with access.admin_origin_rejected, before the permission check". https://github.com/DevilTea/uiux/blob/be5692f7ad625c0b3122ee642e95d2c72d7d03fd/tests/access-http.test.ts#L205
  # Test: code@0297fb9 `scripts/smoke-server.mjs#L451` "smokeConfiguredOrigins: roster administration through the http origin's proxy". https://github.com/DevilTea/uiux/blob/0297fb927d1434cbfcdca592b2408747c6298b2b/scripts/smoke-server.mjs#L451
  # Status: built as of be5692f.
  @spec:id:01a12501-23fa-7f44-9470-62d9f6fb8ab2
  @spec:demonstrates:01a12500-a619-7fa5-b7f6-797adaf52f34
  @spec:demonstrates:01a12500-b105-7773-822f-359d4dcbd1da
  Scenario: Administration is refused on an `http` configured origin
    Given `uiux dev` runs with the configured origin `http://10.0.0.5:3000`
    Given a human member holding `members.manage` is signed in on that origin
    When the member creates a Token on that origin
    Then the request is refused with HTTP 403 `access.admin_origin_rejected`
    Then no Token is created
