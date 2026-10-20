Feature: A credential over its stream limit is refused
  # Source: issue #69 (https://github.com/DevilTea/uiux/issues/69). Decision behind the demonstrated Clause: #241 owner decisions during review of #273, decision 1 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19070362.
  # Test: code@2afaee1 `tests/live-events-http.test.ts#L399` "caps the open streams per credential with 429, and frees a place when a stream closes". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events-http.test.ts#L399
  # Test: code@2afaee1 `tests/live-events.test.ts#L162` "disconnects a client that stops reading once its buffered data passes the bound". https://github.com/DevilTea/uiux/blob/2afaee1fb0157b648ff5a8379200897447c99a27/tests/live-events.test.ts#L162
  # Status: built as of 2afaee1.
  @spec:id:01a15950-86f9-7932-b549-e0b58c3749d0
  @spec:demonstrates:01a1593c-77e1-7c8c-9b2d-e3c460fddda1
  Scenario: A credential over its stream limit is refused
    Given a member has as many change-event streams open on one Token as the limit allows
    When the member opens one more stream with that Token
    Then the server refuses that stream and says when to try again
    Then a stream opened with another credential is still accepted
