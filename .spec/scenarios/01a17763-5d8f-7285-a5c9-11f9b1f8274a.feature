Feature: An interaction change domain affects only interaction Evidence
  # Source: Discussion #241 owner rulings 2026-10-26 (#89 replayable interaction Evidence) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19191424, ruling 2.
  # Status: Not built as of de3052a.
  @spec:id:01a17763-5d8f-7961-bd68-2b387df6e462
  @spec:demonstrates:01a14e30-2dce-7b09-8688-4413e1433f3a
  @spec:demonstrates:01a14e30-2e43-75a7-aca8-c8df28915f4e
  Scenario: An interaction change domain affects only interaction Evidence
    Given a submission whose change domains are only interaction
    When the Evidence it affects is determined for a View it names
    Then the interaction Evidence of that View is affected
    Then no formal capture is affected
