Feature: Access presets
  # Source: Discussion #140 (Part 15, permission keys and role presets), decision 5, A: Label rule 2; R15; owner answer Q7; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: partly built as of becc67d: `uiux member list` shows the Editor label, but the server's member list does not carry labels yet; see the Implementation gaps entry of 01a11c09-c8db-7236-87a1-5720487c486a in its owner.
  # Test: code@47a571a `tests/access-roster-v2.test.ts#L380` "labels an Agent holding the Editor keys it can hold as Editor, preferring the preset with the fewest humanOnly keys (Scenario 01a11c09-d61f)". https://github.com/DevilTea/uiux/blob/47a571afb0c5e4bdd2a708b4170d4cecbab032f7/tests/access-roster-v2.test.ts#L380
  # Test: code@becc67d `tests/access-cli.test.ts#L69` "adds, lists, changes and removes members of one Workspace roster". https://github.com/DevilTea/uiux/blob/becc67dff71c9fb6f31c48729e4a2c030e73ac6c/tests/access-cli.test.ts#L69
  @spec:id:01a11c09-d61f-7c85-a546-ca2ac18603c1
  @spec:demonstrates:01a11c09-c8db-7236-87a1-5720487c486a
  Scenario: An Agent holding the Editor keys it can hold is labeled Editor
    Given the built-in presets
    Given an Agent member holding every key of the Editor preset except `reviews.resolve`
    When a manager lists the members
    Then the Agent is labeled Editor
