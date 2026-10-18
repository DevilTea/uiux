Feature: Adapter selection and resolution
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R5: the `apiVersion` grammar `1` or `1.<minor>` is enforced now, so values such as `1.foo` are refused https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Test: code@402433c `tests/product-adapter-integration.test.ts#L151` "refuses an Adapter whose apiVersion `1.foo` is malformed". https://github.com/DevilTea/uiux/blob/402433cf86c675504930168981368ff06c656664/tests/product-adapter-integration.test.ts#L151
  # Test: code@402433c `tests/product-adapter-integration.test.ts#L129` "refuses API versions outside the `1` / `1.<minor>` grammar". https://github.com/DevilTea/uiux/blob/402433cf86c675504930168981368ff06c656664/tests/product-adapter-integration.test.ts#L129
  # Status: built as of 402433c for the grammar; the declared minor has no effect yet, see the Implementation gaps entry of 01a115cd-d095-790b-bc0b-95297733fed4 in its owner.
  @spec:id:01a14e30-3374-72a1-ba93-910926f263e9
  @spec:demonstrates:01a115cd-d095-790b-bc0b-95297733fed4
  Scenario: An Adapter whose API version is not a valid minor of version 1 is invalid
    Given a Workspace whose Adapter declares `apiVersion` `1.foo`
    When UIUX resolves the Adapter set
    Then the Adapter is invalid because its `apiVersion` is malformed
