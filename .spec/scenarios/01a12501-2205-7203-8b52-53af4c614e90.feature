Feature: Access and roster
  # Source: Discussion #174 (Part 16), Change 2, On a listed origin: the session cookie carries `Secure` when the matched origin is `https`; New Scenarios https://github.com/DevilTea/uiux/discussions/174; accepted as written 2026-10-10 https://github.com/DevilTea/uiux/discussions/174#discussioncomment-18848606.
  # Test: code@be5692f `tests/access-http.test.ts#L193` "sets Secure on the session cookie only for an https origin, whatever X-Forwarded-Proto says". https://github.com/DevilTea/uiux/blob/be5692f7ad625c0b3122ee642e95d2c72d7d03fd/tests/access-http.test.ts#L193
  # Test: code@0297fb9 `scripts/smoke-server.mjs#L461` "smokeConfiguredOrigins: sign-in through the TLS-terminating proxy of the https origin". https://github.com/DevilTea/uiux/blob/0297fb927d1434cbfcdca592b2408747c6298b2b/scripts/smoke-server.mjs#L461
  # Status: built as of be5692f.
  @spec:id:01a12501-2204-79f2-91c4-86cc1d4c7ef5
  @spec:demonstrates:01a11485-f916-7e0c-b6c3-19c0c0b199d2
  Scenario: A configured `https` origin sets a `Secure` session cookie
    Given `uiux dev` runs with the configured origin `https://uiux.example.test`
    Given a human member has a single-use invite
    When the member signs in with the invite through a request whose `Host` is `uiux.example.test`
    Then the session cookie is set with `Secure`
