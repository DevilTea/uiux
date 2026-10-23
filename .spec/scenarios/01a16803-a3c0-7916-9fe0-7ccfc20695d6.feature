Feature: A View that binds a missing Asset is neither rendered nor captured
  # Source: Discussion #9 c2 d5–d6 https://github.com/DevilTea/uiux/discussions/9#discussioncomment-18675243; Discussion #241 owner rulings 2026-10-23 (#97 `$asset` bindings in Views) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19141965, ruling 4.
  # Test: code@24d7784 `tests/asset-bindings-browser.test.ts#L188` "does not render a View that binds a missing Asset, and shows the diagnostic instead". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings-browser.test.ts#L188
  # Test: code@24d7784 `tests/asset-bindings-browser.test.ts#L211` "captures the bound View, and refuses to capture a View whose bound Asset is missing or does not decode". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings-browser.test.ts#L211
  # Test: code@24d7784 `tests/asset-bindings.test.ts#L84` "refuses a binding to a missing or invalid Asset at the binding, with the server's diagnostics, and substitutes nothing". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings.test.ts#L84
  # Status: built as of 24d7784: the capture fails with the binding diagnostics before a browser runs.
  @spec:id:01a16803-a3c0-71da-aa97-41f5df8362fa
  @spec:demonstrates:01a115cd-c09f-7018-9f52-48b05284f600
  @spec:demonstrates:01a115cd-c0d2-7427-8a95-927b2b3518c9
  @spec:demonstrates:01a115cd-c106-71d6-b1f8-4d59cab22ad2
  Scenario: A View that binds a missing Asset is neither rendered nor captured
    Given a View that binds an Asset ID that no Asset has
    When the View opens in the Preview
    When formal capture is asked for the View
    Then the Preview shows the missing binding target at the binding in place of the View
    Then nothing stands in for the Asset
    Then the capture fails and no formal Evidence is recorded
