Feature: The toggle moves the base to the merge base with the default branch
  # Source: [#491 P1: version history is Git's, owner acceptance](https://github.com/DevilTea/uiux/discussions/491#discussioncomment-19699447): the merge base with the default branch is a toggle (Settled details item 1); issue #492 https://github.com/DevilTea/uiux/issues/492.
  # Test: code@9e7126e `tests/git-changes.test.ts#L130` "lists a change committed on the branch only against the merge base, with nothing uncommitted". https://github.com/DevilTea/uiux/blob/9e7126ebbbe528f27adfda2dc6312297aa172777/tests/git-changes.test.ts#L130
  # Status: built as of 9e7126e.
  @spec:id:01a1ece9-a13b-7602-a393-c4fd25c657ff
  @spec:demonstrates:01a1ece7-907a-74bb-9602-d9edcce38e42
  Scenario: The toggle moves the base to the merge base with the default branch
    Given a Workspace inside a Git work tree whose branch committed a change to a View after leaving the default branch, with nothing uncommitted
    When a Reviewer opens the view of changes since the Git base
    When the Reviewer turns the toggle to the merge base with the default branch
    Then the View is listed as changed, which it was not against `HEAD`
