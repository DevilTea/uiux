Feature: Access and roster
  # Source: Discussion #174 (Part 16), Change 2, On a listed origin: the session cookie carries `Secure` when the matched origin is `https`; New Scenarios https://github.com/DevilTea/uiux/discussions/174; accepted as written 2026-10-10 https://github.com/DevilTea/uiux/discussions/174#discussioncomment-18848606.
  # Status: not built as of b9b9e71; see the Implementation gaps entry of 01a11485-f916-7e0c-b6c3-19c0c0b199d2 in its owner.
  # Note: No test exists yet; tracked in issue #176.
  @spec:id:01a12501-2204-79f2-91c4-86cc1d4c7ef5
  @spec:demonstrates:01a11485-f916-7e0c-b6c3-19c0c0b199d2
  Scenario: A configured `https` origin sets a `Secure` session cookie
    Given `uiux dev` runs with the configured origin `https://uiux.example.test`
    Given a human member has a single-use invite
    When the member signs in with the invite through a request whose `Host` is `uiux.example.test`
    Then the session cookie is set with `Secure`
