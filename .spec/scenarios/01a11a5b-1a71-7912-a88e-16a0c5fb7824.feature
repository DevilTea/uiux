Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 1, R4, R7 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a5a-4ba0-745f-a297-bd8d33babded in its owner.
  # Note: No test exists yet.
  @spec:id:01a11a5b-1a71-7b80-b7bb-7a9c84615775
  @spec:demonstrates:01a11a5a-41f3-7474-ba83-128fec22a1f7
  @spec:demonstrates:01a11a5a-4ba0-745f-a297-bd8d33babded
  Scenario: An Adapter that declares theme support under API version 1 is invalid
    Given a Workspace whose Adapter declares `apiVersion` `1` and a `themeSupport` member
    When UIUX resolves the Adapter set
    Then the Adapter is invalid because `themeSupport` needs a later API minor
