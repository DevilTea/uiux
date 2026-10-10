Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d1; d9 `member set` https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344. Restated as permission keys by Discussion #140 (Part 15), decision 7, I1; R18; R25; owner answer Q9 https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: built as of 47a571a.
  # Test: code@47a571a `tests/access-roster-v2.test.ts#L250` "refuses any write that leaves no human holding members.manage (Scenario 01a118a1-d128)". https://github.com/DevilTea/uiux/blob/47a571afb0c5e4bdd2a708b4170d4cecbab032f7/tests/access-roster-v2.test.ts#L250
  # Test: code@47a571a `tests/access-http.test.ts#L376` "adds members, reveals a token once, creates invites, lists and revokes sessions". https://github.com/DevilTea/uiux/blob/47a571afb0c5e4bdd2a708b4170d4cecbab032f7/tests/access-http.test.ts#L376
  # Test: code@47a571a `tests/access-cli.test.ts#L66` "adds, lists, changes and removes members of one Workspace roster". https://github.com/DevilTea/uiux/blob/47a571afb0c5e4bdd2a708b4170d4cecbab032f7/tests/access-cli.test.ts#L66
  @spec:id:01a118a1-d128-7e3e-bbe9-ffb29b33b7dc
  @spec:demonstrates:01a11485-eae3-7080-8f02-da27fc260e09
  @spec:demonstrates:01a114ec-ea2d-7f54-97d1-f981d48795fb
  Scenario: The last human holder of `members.manage` cannot lose it
    Given a roster in which exactly one human member holds `members.manage`
    When `members.manage` is revoked from that member
    Then the change is refused with `access.last_manager`
    Then the roster is unchanged
