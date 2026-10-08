Feature: Version history
  # Source: Discussion #122 (Part 11) d10 rule 5 https://github.com/DevilTea/uiux/discussions/122; "What `.spec/` records after acceptance" key Scenarios https://github.com/DevilTea/uiux/discussions/122; owner acceptance https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a5e-16f7-7229-8d17-587490168f1f in its owner.
  # Note: No test exists yet; tracked in issue #132.
  @spec:id:01a11a5e-9174-7006-b506-038e979982b8
  @spec:demonstrates:01a11a5e-16f7-7229-8d17-587490168f1f
  @spec:demonstrates:01a11a5e-174b-7e74-b232-5ec76601fbed
  @spec:demonstrates:01a11a5e-2768-76ad-b02a-e15f50f91268
  Scenario: A restore with impact needs acknowledgement
    Given a View with a Review thread anchored to a Widget that an earlier version of the View lacks
    When an Editor restores the View to that version without acknowledging impact
    Then nothing is written
    Then the result is `impact_acknowledgement_required` and lists the thread whose anchor would become invalid
