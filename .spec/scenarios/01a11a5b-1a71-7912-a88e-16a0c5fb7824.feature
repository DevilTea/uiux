Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 1, R4, R7 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R5: the member-to-minor binding is deferred until just before the first public publish https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Test: code@2dc9327 `tests/product-adapter-integration.test.ts#L219` "refuses an Adapter that declares apiVersion `1` and a themeSupport member". https://github.com/DevilTea/uiux/blob/2dc93270e42e7a301e85fae6e1786a157040b6cb/tests/product-adapter-integration.test.ts#L219
  # Status: built as of 2dc9327 (issue #137, owner decision of 2026-11-03 to implement it now); the Contract names `themeSupport` as Adapter API `1.2` (01a11a5a-41f3-7474-ba83-128fec22a1f7).
  @spec:id:01a11a5b-1a71-7b80-b7bb-7a9c84615775
  @spec:demonstrates:01a11a5a-41f3-7474-ba83-128fec22a1f7
  @spec:demonstrates:01a11a5a-4ba0-745f-a297-bd8d33babded
  Scenario: An Adapter that declares theme support under API version 1 is invalid
    Given a Workspace whose Adapter declares `apiVersion` `1` and a `themeSupport` member
    When UIUX resolves the Adapter set
    Then the Adapter is invalid because `themeSupport` needs a later API minor
