Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 4, R16, R20 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R1: restated without Adapter style elements, since CSS reaches the Preview only through the Product Kit stylesheet https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Test: code@24cb31a `tests/preview-adapter-providers.test.ts#L390` "fails the construction for a provider that throws, naming the Adapter, `providers` and the entry index, and keeps nothing of it (Scenario 01a11a5b-1960-7fd0-92f5-8cab3317ef3a)". https://github.com/DevilTea/uiux/blob/24cb31acb666f4d348fb6473f817fde0f750638c/tests/preview-adapter-providers.test.ts#L390
  # Status: built as of 24cb31a.
  @spec:id:01a11a5b-1960-7fd0-92f5-8cab3317ef3a
  @spec:demonstrates:01a115cd-ae3e-7ef7-8a53-5ccd86e143bf
  @spec:demonstrates:01a11a5a-4e44-77e0-bdf6-49ab11f5f3a5
  @spec:demonstrates:01a11a5a-5059-716e-b0a5-d178395be034
  Scenario: A provider that throws leaves no Product Kit stylesheet behind
    Given a Workspace whose Adapter has a provider whose install throws
    When a Preview Runtime is constructed
    Then the Preview is reported invalid with a diagnostic naming the Adapter, `providers` and the entry index
    Then the Preview document holds no Product Kit stylesheet link
