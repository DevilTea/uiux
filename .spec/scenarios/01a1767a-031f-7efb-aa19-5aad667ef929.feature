Feature: A recorded Run Checks result is not a formal capture
  # Source: Discussion #241 owner rulings 2026-10-26 (#348 Run Checks Evidence), ruling 2: https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19186750.
  # Test: code@a668006 `tests/checks-run-evidence.test.ts#L213` "is read by no consumer of formal captures: not listed as Evidence, and not in a Handoff assessment". https://github.com/DevilTea/uiux/blob/a668006/tests/checks-run-evidence.test.ts#L213
  # Status: built as of a668006.
  @spec:id:01a1767a-031f-7630-b294-aa048d964710
  @spec:demonstrates:01a17671-6251-75dc-a810-088743e727d0
  Scenario: A recorded Run Checks result is not a formal capture
    Given a stored checks_run Evidence record
    When formal Evidence is listed and Handoff readiness is assessed
    Then the record is in neither result
