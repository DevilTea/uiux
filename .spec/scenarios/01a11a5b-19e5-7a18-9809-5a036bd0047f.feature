Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 1, R3 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a5a-4aa0-7537-bbfc-600ea0ea61c5 in its owner.
  # Note: No test exists yet.
  @spec:id:01a11a5b-19e5-71b3-9437-91affc2bc786
  @spec:demonstrates:01a11a5a-4aa0-7537-bbfc-600ea0ea61c5
  @spec:demonstrates:01a11a5a-4b1f-7ebf-bd9f-e9156ae438d0
  Scenario: An Adapter that needs a newer API minor than UIUX is refused with upgrade guidance
    Given a Workspace whose Adapter declares an API minor above the highest one the running UIUX implements
    When UIUX resolves the Adapter set
    Then the Adapter is invalid with an incompatible API version
    Then the Workbench guidance is to upgrade UIUX to a release that implements that minor
