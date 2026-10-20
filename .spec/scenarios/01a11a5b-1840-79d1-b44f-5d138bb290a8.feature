Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12, Adapter contract amendments), decision 5, R22–R23 https://github.com/DevilTea/uiux/discussions/130; accepted in full 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264.
  # Test: code@24cb31a `tests/preview-adapter-providers.test.ts#L333` "renders differently for two configuration values, each in its own bundle (Scenario 01a11a5b-183f-79b7-944c-eb7ab182cee0)". https://github.com/DevilTea/uiux/blob/24cb31acb666f4d348fb6473f817fde0f750638c/tests/preview-adapter-providers.test.ts#L333
  # Status: built as of 24cb31a.
  @spec:id:01a11a5b-183f-79b7-944c-eb7ab182cee0
  @spec:demonstrates:01a11a5a-515e-7c1d-9990-82e883c33243
  Scenario: A provider receives its Adapter entry's validated configuration
    Given a Workspace whose Adapter declares a configuration schema and a provider that hands its configuration to the Adapter's renderers
    When the Preview renders a View with that Adapter entry's configuration set to one value and then to another
    Then the provider receives each value as a frozen copy of the validated configuration
    Then the View renders differently for the two values
