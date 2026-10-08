Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 5, R22–R23 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a5a-515e-7c1d-9990-82e883c33243 in its owner.
  # Note: No test exists yet.
  @spec:id:01a11a5b-183f-79b7-944c-eb7ab182cee0
  @spec:demonstrates:01a11a5a-515e-7c1d-9990-82e883c33243
  Scenario: A provider receives its Adapter entry's validated configuration
    Given a Workspace whose Adapter declares a configuration schema and a provider that hands its configuration to the Adapter's renderers
    When the Preview renders a View with that Adapter entry's configuration set to one value and then to another
    Then the provider receives each value as a frozen copy of the validated configuration
    Then the View renders differently for the two values
