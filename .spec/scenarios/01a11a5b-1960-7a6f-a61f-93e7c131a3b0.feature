Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 4, R16, R20 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a5a-4e44-77e0-bdf6-49ab11f5f3a5 in its owner.
  # Note: No test exists yet.
  @spec:id:01a11a5b-1960-7fd0-92f5-8cab3317ef3a
  @spec:demonstrates:01a115cd-ae3e-7ef7-8a53-5ccd86e143bf
  @spec:demonstrates:01a11a5a-4e44-77e0-bdf6-49ab11f5f3a5
  @spec:demonstrates:01a11a5a-5059-716e-b0a5-d178395be034
  Scenario: A provider that throws leaves no Adapter style behind
    Given a Workspace whose Adapter has a style entry and a provider whose install throws
    When a Preview Runtime is constructed
    Then the Preview is reported invalid with a diagnostic naming the Adapter, `providers` and the entry index
    Then the Preview document holds no style element of that Adapter
