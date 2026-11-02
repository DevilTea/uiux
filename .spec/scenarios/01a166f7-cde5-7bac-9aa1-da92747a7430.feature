Feature: A capability failure shows the inline Preview diagnostic
  # Source: issue #111 (https://github.com/DevilTea/uiux/issues/111). Decisions behind the demonstrated Rules: #2 c15 d1, d3 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18654094; #2 c32 d1 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18655698.
  # Test: code@c15227e `tests/preview-failure-browser.test.ts#L138` "shows a capability failure inline, and Retry Preview recovers through one explicit retry", whose first part forces the capability failure and reads the diagnostic and its details. https://github.com/DevilTea/uiux/blob/c15227ed7777cda6a979a8b5f212b905aac5f255/tests/preview-failure-browser.test.ts#L138
  # Test: code@c15227e `tests/preview-failure-diagnostic.test.ts#L34` "keeps the reason of a capability failure, correlated with the session and the failed generation". https://github.com/DevilTea/uiux/blob/c15227ed7777cda6a979a8b5f212b905aac5f255/tests/preview-failure-diagnostic.test.ts#L34
  # Test: code@c15227e `tests/preview-failure-diagnostic.test.ts#L117` "takes the title from the category and the body from a recognized reason". https://github.com/DevilTea/uiux/blob/c15227ed7777cda6a979a8b5f212b905aac5f255/tests/preview-failure-diagnostic.test.ts#L117
  # Status: built as of c15227e (issue #111) for the failures the Workbench derives, which this Scenario exercises; `transport.channel_unavailable`, which it does not exercise, is derived as of 3ae6357 (issue #467): see Scenario 01a19a12-349c-7475-a381-25a8a7cb3951.
  @spec:id:01a166f7-cde5-76e1-9565-e94c6094f4d7
  @spec:demonstrates:01a11687-375e-7667-b8f1-59389fdd9780
  @spec:demonstrates:01a11687-37a0-77bb-a857-5f7804b7c306
  @spec:demonstrates:01a11687-3828-7160-b15b-13827988070e
  Scenario: A capability failure shows the inline Preview diagnostic
    Given a Preview runtime that declares a protocol version the Workbench does not support
    When the Workbench receives its capability declaration
    Then the Workbench shows a persistent, non-modal inline Preview diagnostic titled by the `capability` category
    Then its body is the copy of the `capability.unsupported_protocol_version` reason
    Then the reason and the Preview session and generation identities appear only in its expandable technical details
