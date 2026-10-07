Feature: Access and roster
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c177 d8 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18758344.
  # Test: code@a021f9e `tests/access-http.test.ts#L114` "prints a one-time Owner sign-in link only once, and signs a browser in through the fragment invite". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/access-http.test.ts#L114
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d172-7b56-928f-865be4bd8eca
  @spec:demonstrates:01a11485-eb1a-77fb-a91e-b54c505344da
  @spec:demonstrates:01a114ec-e085-7353-bb10-6fa44d0e8cd5
  Scenario: The first server start creates an Owner and prints its sign-in link once
    Given a Workspace whose roster has no human Owner
    When `uiux dev` starts on it
    When the server is later started again
    Then the first start creates a human Owner and prints a single-use sign-in link for it
    Then the later start prints no sign-in link and no Token
