Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c9 d1, R1 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095; #1 c178 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18772098.
  # Test: code@a021f9e `tests/review-v3-browser.test.ts#L80` "creates a Workspace comment from the inbox: New comment, ⌘↵, then the row and detail say "Workspace"". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-v3-browser.test.ts#L80
  # Test: code@a021f9e `tests/review-scope-and-edit.test.ts#L98` "creates a Workspace thread on both transports and refuses Variant scope and a display hint". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-scope-and-edit.test.ts#L98
  # Status: built as of a021f9e.
  @spec:id:01a118a1-c90b-7cb1-8b9e-69f6a6140a3b
  @spec:demonstrates:01a11544-5194-7c98-adf1-fc0a302a569f
  @spec:demonstrates:01a11544-540d-765c-8552-d1f3a4d0ef10
  @spec:demonstrates:01a11544-5dad-7d4c-b8e4-e1080c880bda
  Scenario: A Reviewer starts a Workspace comment from the inbox
    Given the Reviews inbox is open
    When the Reviewer writes a new comment about the product as a whole
    Then the thread is anchored to the Workspace and names no View or Widget
    Then no View's canvas shows a pin for it
