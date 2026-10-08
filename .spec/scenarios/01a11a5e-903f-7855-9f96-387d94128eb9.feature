Feature: Version history
  # Source: Discussion #122 (Part 11) d3 B boundaries 1 and 3, R5, R6 https://github.com/DevilTea/uiux/discussions/122; "What `.spec/` records after acceptance" key Scenarios https://github.com/DevilTea/uiux/discussions/122#what-spec-records-after-acceptance; owner acceptance https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a5d-ff1c-7af9-b69b-cb6dc362143e in its owner.
  # Note: No test exists yet; tracked in issue #132.
  @spec:id:01a11a5e-903e-7f82-8268-0c09e825a9e1
  @spec:demonstrates:01a11a5d-ff1c-7af9-b69b-cb6dc362143e
  @spec:demonstrates:01a11a5d-ff72-7fbb-886f-d1f56f321e98
  @spec:demonstrates:01a11a5e-0068-7a4b-b4bc-3cb282b4ae5a
  Scenario: One Agent task becomes one autosave
    Given an Agent member with the Editor role and no open autosave
    When the Agent makes several design writes through `/mcp`
    When the Agent calls `release_lock` with no arguments
    Then the timeline shows one autosave whose actor is the Agent
    Then the autosave lists each of those writes as a write event
