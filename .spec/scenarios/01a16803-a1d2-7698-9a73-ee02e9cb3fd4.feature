Feature: A Preview renders an Asset bound in an asset-capable field
  # Source: Discussion #241 owner rulings 2026-10-23 (#97 `$asset` bindings in Views) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19141965, rulings 1 and 2; Discussion #9 c2 d5–d6 https://github.com/DevilTea/uiux/discussions/9#discussioncomment-18675243.
  # Test: code@24d7784 `tests/asset-bindings-browser.test.ts#L168` "renders the Asset from its resolved URL, and the Widget receives the runtime value". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings-browser.test.ts#L168
  # Test: code@24d7784 `tests/asset-bindings.test.ts#L64` "gives the Widget the resolved runtime value under the same field, frozen, and leaves the authored View alone". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings.test.ts#L64
  # Status: built as of 24d7784.
  @spec:id:01a16803-a1d2-72ae-bf61-3b28f00fbdbd
  @spec:demonstrates:01a115cd-bf1c-7ab1-933d-c03322035cc5
  @spec:demonstrates:01a115cd-bf4e-71ae-9fdb-74cc91862738
  @spec:demonstrates:01a167f4-3e4e-7af1-b328-30fb52f7f4c5
  @spec:demonstrates:01a167f4-401d-7330-ac65-0a900adbccd6
  Scenario: A Preview renders an Asset bound in an asset-capable field
    Given a View that binds an image Asset in a field its Adapter Catalog declares asset-capable
    When the View opens in the Preview
    Then the Widget's Config holds the Asset's URL, media type and content digest under that field
    Then the image renders from that URL
