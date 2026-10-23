Feature: Writing a View that binds a missing Asset succeeds, and its diagnostics name the binding
  # Source: Discussion #241 owner rulings 2026-10-23 (#97 `$asset` bindings in Views) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19141965, ruling 4.
  # Test: code@24d7784 `tests/asset-bindings-browser.test.ts#L202` "lists the binding's diagnostic in the View's server-side diagnostics, which Checks read (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c)". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings-browser.test.ts#L202
  # Test: code@24d7784 `tests/asset-bindings.test.ts#L193` "checks a View's bindings for its diagnostics against the Catalog, or only their Assets while the Adapters cannot resolve (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c)". https://github.com/DevilTea/uiux/blob/24d7784a802f5ea1fbbfcb7b40e2e71ba4da226e/tests/asset-bindings.test.ts#L193
  # Status: built as of 24d7784: the browser test writes the View through `POST /api/views` and `PUT /api/views/:id/structure`.
  @spec:id:01a16803-a5a7-784a-bffb-37e7abfd5c34
  @spec:demonstrates:01a167f4-456c-78c5-b7e1-843cb39bcab8
  @spec:demonstrates:01a167f4-472f-7ae9-8ebb-3075216ad94c
  Scenario: Writing a View that binds a missing Asset succeeds, and its diagnostics name the binding
    Given no Asset has a given ID
    When an author writes a View that binds that ID
    Then the write succeeds
    Then the View's diagnostics list the missing binding target at the binding
