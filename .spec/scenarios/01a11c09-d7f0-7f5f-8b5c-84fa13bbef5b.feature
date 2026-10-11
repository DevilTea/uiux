Feature: Access and roster
  # Source: Discussion #140 (Part 15, permission keys and role presets), decision 11, A; R23; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: built as of 47a571a.
  # Test: code@47a571a `tests/access-roster-v2.test.ts#L112` "upgrades a version 1 roster on first open, keeps it as access.v1.json and keeps every credential working". https://github.com/DevilTea/uiux/blob/47a571afb0c5e4bdd2a708b4170d4cecbab032f7/tests/access-roster-v2.test.ts#L112
  # Test: code@47a571a `tests/access-roster-v2.test.ts#L169` "upgrades once when several processes open the version 1 roster at the same time, backing up only the version 1 file". https://github.com/DevilTea/uiux/blob/47a571afb0c5e4bdd2a708b4170d4cecbab032f7/tests/access-roster-v2.test.ts#L169
  # Test: code@47a571a `tests/access-roster-v2.test.ts#L178` "finishes an upgrade that stopped after the backup, replacing the stale backup". https://github.com/DevilTea/uiux/blob/47a571afb0c5e4bdd2a708b4170d4cecbab032f7/tests/access-roster-v2.test.ts#L178
  @spec:id:01a11c09-d7ef-7fde-a505-929046492a07
  @spec:demonstrates:01a11bb1-b427-777e-8175-fa24d61d434b
  @spec:demonstrates:01a11c09-a195-768b-ba6e-a64eb7f05eca
  @spec:demonstrates:01a11c09-b623-7824-8745-9c10510d0d53
  @spec:demonstrates:01a11c09-b698-7ee3-861b-f02eaba61269
  Scenario: A version 1 roster upgrades on first open and keeps a backup
    Given a version 1 roster with a human Owner and an Agent Editor
    When `uiux dev` opens it
    Then the roster is at version 2 and the human member holds the keys of the Owner preset
    Then the Agent holds the keys of the Editor preset except `reviews.resolve`
    Then `access.v1.json` beside the roster holds the version 1 roster
