Feature: A capability failure shows the inline Preview diagnostic
  # Source: issue #111 (https://github.com/DevilTea/uiux/issues/111). Decisions behind the demonstrated Rules: #2 c15 d1, d3 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18654094; #2 c32 d1 https://github.com/DevilTea/uiux/discussions/2#discussioncomment-18655698.
  # Test: code@3931ea3 `tests/preview-failure-browser.test.ts#L92` "shows a capability failure inline, and Retry Preview recovers through one explicit retry", whose first part forces the capability failure and reads the diagnostic and its details. https://github.com/DevilTea/uiux/blob/3931ea330b5c8b2dc4a4e21ef37316b956df256b/tests/preview-failure-browser.test.ts#L92
  # Test: code@3931ea3 `tests/preview-failure-diagnostic.test.ts#L31` "keeps the reason of a capability failure, correlated with the session and the failed generation". https://github.com/DevilTea/uiux/blob/3931ea330b5c8b2dc4a4e21ef37316b956df256b/tests/preview-failure-diagnostic.test.ts#L31
  # Test: code@3931ea3 `tests/preview-failure-diagnostic.test.ts#L98` "takes the title from the category and the body from a recognized reason". https://github.com/DevilTea/uiux/blob/3931ea330b5c8b2dc4a4e21ef37316b956df256b/tests/preview-failure-diagnostic.test.ts#L98
  # Status: built as of 3931ea3 for the failures the Workbench derives; see the Implementation gaps entry of 01a11687-375e-7667-b8f1-59389fdd9780 in its owner.
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
