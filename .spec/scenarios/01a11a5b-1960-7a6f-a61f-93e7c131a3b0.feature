Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 4, R16, R20 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R1: restated without Adapter style elements, since CSS reaches the Preview only through the Product Kit stylesheet https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Status: not built as of cf3b984: no provider entry is installed, so none can throw (issue #126); 01a11a5a-4e44-77e0-bdf6-49ab11f5f3a5 is built as of 87211f6, and 01a11a5a-5059-716e-b0a5-d178395be034 is partly built as of 87211f6 (a failing Product Kit stylesheet, which this Scenario does not show); see the Implementation gaps entry of 01a11a5a-5059-716e-b0a5-d178395be034 in its owner.
  # Note: No test exists yet.
  @spec:id:01a11a5b-1960-7fd0-92f5-8cab3317ef3a
  @spec:demonstrates:01a115cd-ae3e-7ef7-8a53-5ccd86e143bf
  @spec:demonstrates:01a11a5a-4e44-77e0-bdf6-49ab11f5f3a5
  @spec:demonstrates:01a11a5a-5059-716e-b0a5-d178395be034
  Scenario: A provider that throws leaves no Product Kit stylesheet behind
    Given a Workspace whose Adapter has a provider whose install throws
    When a Preview Runtime is constructed
    Then the Preview is reported invalid with a diagnostic naming the Adapter, `providers` and the entry index
    Then the Preview document holds no Product Kit stylesheet link
