Feature: Command-line interface
  # Source: Discussion #231 (Part 17, one current format) https://github.com/DevilTea/uiux/discussions/231; owner acceptance 2026-10-17 https://github.com/DevilTea/uiux/discussions/231#discussioncomment-18992111: Change 6.5 and the `.spec/` units New table (it replaces the retired Scenario 01a11bb1-bf7f-7c8e-bec7-1511c5f7d36f, the only one that demonstrated 01a1144e-56bd-7988-8d2a-87b23954ca49); owner question Q5.
  # Status: built as of 21c5130.
  # Test: code@21c5130 `tests/access-cli.test.ts#L151` "copies a roster to a new Workspace path once, keeping tokens and dropping sessions" (the Token verifies against the new path, and a later copy from the removed old directory also succeeds). https://github.com/DevilTea/uiux/blob/21c5130507037de588fe579086709bad80c0da1d/tests/access-cli.test.ts#L151
  @spec:id:01a14917-8d4a-7839-af30-a42285eabfad
  @spec:demonstrates:01a1144e-56bd-7988-8d2a-87b23954ca49
  Scenario: A moved Workspace keeps its Tokens after uiux access copy
    Given a Workspace whose roster holds a member Token
    Given the Workspace directory is moved to a new path
    When an operator runs `uiux access copy --from` the old path on the moved Workspace
    Then the member Token authenticates against the moved Workspace
