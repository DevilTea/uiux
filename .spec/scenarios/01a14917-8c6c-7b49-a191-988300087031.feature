Feature: Member roster and permission keys
  # Source: Discussion #231 (Part 17, one current format) https://github.com/DevilTea/uiux/discussions/231; owner acceptance 2026-10-17 https://github.com/DevilTea/uiux/discussions/231#discussioncomment-18992111: Change 6.1, the `.spec/` units New table.
  # Status: not built as of 21c5130: a `version: 1` roster is still upgraded in place with an `access.v1.json` backup; see the Implementation gaps entry of 01a14917-7898-72fa-a8ad-ed737e4a9eae in its owner (issue #232).
  # Note: No test exists yet.
  @spec:id:01a14917-8c6c-7033-a28b-c6ff352dfa9d
  @spec:demonstrates:01a14917-7898-72fa-a8ad-ed737e4a9eae
  Scenario: A version 1 roster is refused and left unchanged
    Given a Workspace whose roster file has `version: 1`
    When an operator runs `uiux member list` on it
    Then the command fails with `access.store_invalid`, naming the roster file and its version
    Then the roster file is byte-identical and no `access.v1.json` exists beside it
