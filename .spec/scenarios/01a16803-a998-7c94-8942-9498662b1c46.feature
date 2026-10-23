Feature: Replacing a bound Asset makes the open Preview resolve it again
  # Source: Discussion #241 owner rulings 2026-10-23 (#97 `$asset` bindings in Views) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19141965, rulings 2 and 4.
  # Test: code@24d7784 `tests/asset-bindings-browser.test.ts#L282` "resolves the open Preview again when the bound Asset is replaced, and refuses the old URL". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings-browser.test.ts#L282
  # Test: code@24d7784 `tests/asset-bindings.test.ts#L134` "make a Preview resolve again only when one of them changes, or after a resync". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings.test.ts#L134
  # Status: built as of 24d7784.
  @spec:id:01a16803-a998-7dcf-b90b-3c9482fbe554
  @spec:demonstrates:01a167f4-41f2-70a1-a200-a005d47b12b5
  @spec:demonstrates:01a167f4-48f2-7460-8c12-dfc4cda35cd0
  Scenario: Replacing a bound Asset makes the open Preview resolve it again
    Given an open Preview of a View that binds an Asset
    When the Asset's content is replaced
    Then the Preview renders the new content from a new URL
    Then the old URL is refused because the content no longer has its digest
