Feature: A member without evidence.capture does not record a Run Checks result
  # Source: Discussion #241 owner rulings 2026-10-26 (#348 Run Checks Evidence), ruling 2: https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19186750.
  # Test: code@a668006 `tests/checks-run-evidence.test.ts#L195` "writes nothing for a member without evidence.capture, and checks the key before the input". https://github.com/DevilTea/uiux/blob/a668006/tests/checks-run-evidence.test.ts#L195
  # Test: code@a668006 `tests/checks-run-evidence-browser.test.ts#L92` "runs for a member without evidence.capture, says the run was not recorded, and writes nothing". https://github.com/DevilTea/uiux/blob/a668006/tests/checks-run-evidence-browser.test.ts#L92
  # Status: built as of a668006.
  @spec:id:01a17679-ffdd-7bb6-a8fe-4016de60c6ae
  @spec:demonstrates:01a17671-11bf-7711-887b-121a02602cf4
  Scenario: A member without evidence.capture does not record a Run Checks result
    Given a member without evidence.capture
    When the member records a Run Checks result
    Then the request is refused naming evidence.capture and nothing is stored
    Then the run in the Workbench still lists its findings and says it was not recorded
