Feature: Version history
  # Source: Discussion #122 (Part 11) decision 3 B (autosaves) and boundary 3, R6 https://github.com/DevilTea/uiux/discussions/122; "What `.spec/` records after acceptance" key Scenarios https://github.com/DevilTea/uiux/discussions/122; owner acceptance https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263. Restated as permission keys by Discussion #140 (Part 15), decision 13, A: the precondition names `views.write` https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: built as of 673b166.
  # Test: code@673b166 `tests/history-recorder.test.ts#L659` "records one Agent task over /mcp, ended by release_lock, as one autosave (Scenario 01a11a5e-903e)". https://github.com/DevilTea/uiux/blob/673b166561530c1dc5855148404fd7bbdf0edc39/tests/history-recorder.test.ts#L659
  # Note: Discussion #140 restates the precondition as `views.write` (issue #142); the test grants it through the Editor role.
  @spec:id:01a11a5e-903e-7f82-8268-0c09e825a9e1
  @spec:demonstrates:01a11a5d-ff1c-7af9-b69b-cb6dc362143e
  @spec:demonstrates:01a11a5e-0068-7a4b-b4bc-3cb282b4ae5a
  Scenario: One Agent task becomes one autosave
    Given an Agent member holding `views.write` and no open autosave
    When the Agent makes several design writes through `/mcp`, each within the autosave idle period of the previous one
    When the Agent calls `release_lock` with no arguments
    Then the timeline shows one autosave whose actor is the Agent
    Then the autosave lists each of those writes as a write event
