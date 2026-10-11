Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d8 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344. Restated as permission keys by Discussion #140 (Part 15), decision 7, I3; R19 https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: built as of 47a571a.
  # Test: code@47a571a `tests/access-roster-v2.test.ts#L325` "loads a roster with no human manager, grants nobody more than its keys, and bootstraps a manager with every key (Scenario 01a118a1-d172)". https://github.com/DevilTea/uiux/blob/47a571afb0c5e4bdd2a708b4170d4cecbab032f7/tests/access-roster-v2.test.ts#L325
  # Test: code@47a571a `tests/access-http.test.ts#L121` "prints a one-time Owner sign-in link only once, and signs a browser in through the fragment invite". https://github.com/DevilTea/uiux/blob/47a571afb0c5e4bdd2a708b4170d4cecbab032f7/tests/access-http.test.ts#L121
  @spec:id:01a118a1-d172-7b56-928f-865be4bd8eca
  @spec:demonstrates:01a11485-eb1a-77fb-a91e-b54c505344da
  @spec:demonstrates:01a114ec-e085-7353-bb10-6fa44d0e8cd5
  Scenario: The first server start creates a manager and prints its sign-in link once
    Given a Workspace whose roster has no human member holding `members.manage`
    When `uiux dev` starts on it
    When the server is later started again
    Then the first start creates a human member with every catalog key and prints a single-use sign-in link for it
    Then the later start prints no sign-in link and no Token
