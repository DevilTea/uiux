Feature: Adapter selection and resolution
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R5: the `apiVersion` grammar `1` or `1.<minor>` is enforced now, so values such as `1.foo` are refused https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Status: not built as of 3477f81; see the Implementation gaps entry of 01a115cd-d095-790b-bc0b-95297733fed4 in its owner.
  # Note: No test exists yet.
  @spec:id:01a14e30-3374-72a1-ba93-910926f263e9
  @spec:demonstrates:01a115cd-d095-790b-bc0b-95297733fed4
  Scenario: An Adapter whose API version is not a valid minor of version 1 is invalid
    Given a Workspace whose Adapter declares `apiVersion` `1.foo`
    When UIUX resolves the Adapter set
    Then the Adapter is invalid because its `apiVersion` is malformed
