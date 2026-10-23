Feature: A field accepts an Asset by its media type or by the top-level type of it
  # Source: Discussion #241 owner rulings 2026-10-23 (#97 `$asset` bindings in Views) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19141965, rulings 3 and 4; Discussion #9 c2 d5–d6 https://github.com/DevilTea/uiux/discussions/9#discussioncomment-18675243.
  # Test: code@24d7784 `tests/asset-bindings.test.ts#L117` "takes the top-level type of the media type as the category". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings.test.ts#L117
  # Test: code@24d7784 `tests/asset-bindings.test.ts#L103` "refuses an Asset whose media type and category the field does not accept". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings.test.ts#L103
  # Test: code@24d7784 `tests/asset-bindings-browser.test.ts#L251` "reports an Asset the field does not accept in the View's server-side diagnostics". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings-browser.test.ts#L251
  # Status: built as of 24d7784.
  @spec:id:01a16803-a79e-7e97-916d-019fcb5d0d14
  @spec:demonstrates:01a115cd-c06c-730f-a979-2491cadfb238
  @spec:demonstrates:01a167f4-43a6-772b-9304-410708912c4e
  Scenario: A field accepts an Asset by its media type or by the top-level type of it
    Given a field whose Catalog entry accepts the category image
    When a View binds a PNG Asset there
    When another View binds a PDF Asset there
    Then the PNG binding is accepted
    Then the PDF binding is a View validation error
