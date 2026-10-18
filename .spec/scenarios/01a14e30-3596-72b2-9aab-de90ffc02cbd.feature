Feature: View Variants
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R7: a Variant entry is exactly `{ state }`, and unknown entry keys are rejected https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Status: not built as of 3477f81: the unknown key is ignored without a diagnostic; see the Implementation gaps entry of 01a1144e-5423-7def-a70a-7962ad2d2af7 in its owner.
  # Note: No test exists yet.
  @spec:id:01a14e30-3596-71c9-aedf-4485f5fced19
  @spec:demonstrates:01a1144e-5423-7def-a70a-7962ad2d2af7
  Scenario: A Variant entry with a key other than state is refused
    Given a View whose Variant entry holds `state` and `config`
    When UIUX validates the View
    Then the View is invalid with a diagnostic at that entry's `config`
