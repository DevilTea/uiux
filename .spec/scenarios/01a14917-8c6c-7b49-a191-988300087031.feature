Feature: Access and roster
  # Source: Discussion #231 (Part 17, one current format) https://github.com/DevilTea/uiux/discussions/231; owner acceptance 2026-10-17 https://github.com/DevilTea/uiux/discussions/231#discussioncomment-18992111: Change 6.1, the `.spec/` units New table.
  # Test: code@22e4d84 `tests/access-cli.test.ts#L186` "refuses a version 1 roster in uiux member list and as an access copy source, leaving it unchanged (Clause 01a14917-7898, Scenario 01a14917-8c6c)". https://github.com/DevilTea/uiux/blob/22e4d847818b6c629ecd9fab4b928a8e2b522c35/tests/access-cli.test.ts#L186
  # Test: code@22e4d84 `tests/access-roster-v2.test.ts#L110` "refuses a version 1 roster on open, naming the file and its version, and never rewrites it or backs it up (Scenario 01a14917-8c6c)". https://github.com/DevilTea/uiux/blob/22e4d847818b6c629ecd9fab4b928a8e2b522c35/tests/access-roster-v2.test.ts#L110
  # Status: built as of 22e4d84.
  @spec:id:01a14917-8c6c-7033-a28b-c6ff352dfa9d
  @spec:demonstrates:01a14917-7898-72fa-a8ad-ed737e4a9eae
  Scenario: A version 1 roster is refused and left unchanged
    Given a Workspace whose roster file has `version: 1`
    When an operator runs `uiux member list` on it
    Then the command fails with `access.store_invalid`, naming the roster file and its version
    Then the roster file is byte-identical and no `access.v1.json` exists beside it
