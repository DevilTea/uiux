Feature: Two Run Checks with identical results are recorded as two Evidence records
  # Source: Discussion #241 owner rulings 2026-10-26 (#348 Run Checks Evidence), ruling 2: https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19186750.
  # Test: code@a668006 `tests/checks-run-evidence.test.ts#L142` "records the same result through the application, the HTTP helper and MCP, as one immutable record". https://github.com/DevilTea/uiux/blob/a668006/tests/checks-run-evidence.test.ts#L142
  # Test: code@a668006 `tests/checks-run-evidence.test.ts#L166` "makes two runs with identical results two records, because ranAt differs". https://github.com/DevilTea/uiux/blob/a668006/tests/checks-run-evidence.test.ts#L166
  # Test: code@a668006 `tests/checks-run-evidence-browser.test.ts#L47` "records one checks_run record per run, two for two runs with identical results, and shows the last one". https://github.com/DevilTea/uiux/blob/a668006/tests/checks-run-evidence-browser.test.ts#L47
  # Status: built as of a668006.
  @spec:id:01a17679-fcb5-77fb-9ff7-0a3c0893c9f9
  @spec:demonstrates:01a115cd-bc2c-795f-babe-0d19eb80de96
  @spec:demonstrates:01a17670-d442-7068-8a08-c6e4ab9c09ae
  @spec:demonstrates:01a17671-11bf-7711-887b-121a02602cf4
  Scenario: Two Run Checks with identical results are recorded as two Evidence records
    Given a member holding evidence.capture who has run Checks twice with identical results
    When the Workbench records each run
    Then two checks_run Evidence records are stored, told apart by their ranAt
    Then Overview Checks shows the identity and time of the last recorded run
