Feature: An interaction replay is stale once the render input of its View changed
  # Source: Discussion #241 owner rulings 2026-10-26 (#89 replayable interaction Evidence) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19191424, ruling 2; issue #88.
  # Test: code@8c77b6e `tests/evidence-staleness.test.ts#L391` "is fresh and stale by the conditions of the capture it copies". https://github.com/DevilTea/uiux/blob/8c77b6e/tests/evidence-staleness.test.ts#L391
  # Status: built as of 8c77b6e.
  @spec:id:01a177b3-9ae5-75ff-a44a-c3795a7c6d48
  @spec:demonstrates:01a14e30-2e43-75a7-aca8-c8df28915f4e
  Scenario: An interaction replay is stale once the render input of its View changed
    Given an interaction_replay record of a View
    When the View's IR or a Variant changes
    Then the interaction replay is stale like the capture it references
