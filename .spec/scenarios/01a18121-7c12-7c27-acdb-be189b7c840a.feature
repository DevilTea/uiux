Feature: Requirement references
  # Source: Discussion #379 (closed loop) [#379 body: P3: Coverage](https://github.com/DevilTea/uiux/discussions/379); owner acceptance 2026-10-28 https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19234465; scenario chosen in its `.spec/` PR.
  # Test: code@ad0fc2e `tests/requirement-references.test.ts#L453` "counts a requirement that only a Variant references, with referencedBy naming the Variant". https://github.com/DevilTea/uiux/blob/ad0fc2e54bc67c53d74b3b94becbf0caeec92ee4/tests/requirement-references.test.ts#L453
  # Test: code@ad0fc2e `tests/requirements-browser.test.ts#L92` "lists each requirement as referenced, unreferenced or noUi, the unresolved IDs and the coverage, linked to what references them". https://github.com/DevilTea/uiux/blob/ad0fc2e54bc67c53d74b3b94becbf0caeec92ee4/tests/requirements-browser.test.ts#L92
  # Status: built as of ad0fc2e.
  @spec:id:01a18121-7c11-7a8a-8952-45198dd8ee7f
  @spec:demonstrates:01a18120-f903-7f8d-9b44-d581ab520c0d
  @spec:demonstrates:01a18120-fa17-7184-be86-43753e4614af
  @spec:demonstrates:01a18120-fd5d-7226-bc8c-5aabd117ce88
  @spec:demonstrates:01a18120-fde6-7fae-bc6f-c5ceffe81b12
  @spec:demonstrates:01a18120-ff8e-7eaa-9931-814e92da017b
  Scenario: Coverage counts a requirement that only a Variant references
    Given a Workspace whose `spec` provider has four requirements, one of them marked `noUi`
    Given a View that lists the first requirement and has a Variant that lists the second
    When an Agent reads the Resource `uiux://requirements`
    Then the first and the second requirement are `referenced`, the third is `unreferenced` and the fourth is `noUi`
    Then `counts` is 2 referenced, 1 unreferenced, 1 `noUi` and 0 unresolved
