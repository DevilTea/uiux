Feature: Version history
  # Source: Discussion #122 (Part 11) d5 Changes outside UIUX https://github.com/DevilTea/uiux/discussions/122; "What `.spec/` records after acceptance" key Scenarios https://github.com/DevilTea/uiux/discussions/122; owner acceptance https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263.
  # Status: built as of 3ae264d.
  # Test: code@3ae264d `tests/history-checkpoints.test.ts#L205` "closes the open autosave first and records an outside change as an external version before the Checkpoint (Rules 01a11a5e-00b9 and 0313)". https://github.com/DevilTea/uiux/blob/3ae264dd229937e412f5041396711eb44a2c9dbe/tests/history-checkpoints.test.ts#L205
  # Test: code@673b166 `tests/history-recorder.test.ts#L693` "records an edit made outside UIUX as an external version before a Checkpoint boundary (Scenario 01a11a5e-91d5)". https://github.com/DevilTea/uiux/blob/673b166561530c1dc5855148404fd7bbdf0edc39/tests/history-recorder.test.ts#L693
  # Test: code@673b166 `tests/history-recorder.test.ts#L201` "records a change made while no server ran as an external version at start (Scenario 01a11a5e-91d5)". https://github.com/DevilTea/uiux/blob/673b166561530c1dc5855148404fd7bbdf0edc39/tests/history-recorder.test.ts#L201
  # Note: The open gap of 01a11a5e-21c4-79f7-b6f9-4128d842c278 (the `system:migrate` actor, issue #132, B7) is not exercised by these steps.
  @spec:id:01a11a5e-91d5-7576-9bc3-d0da98e93169
  @spec:demonstrates:01a11a5e-0313-7d86-af79-8eafa1753853
  @spec:demonstrates:01a11a5e-21c4-79f7-b6f9-4128d842c278
  Scenario: An edit made outside UIUX shows as an external version
    Given a running `uiux dev` server for a Workspace
    When a text editor changes a View file outside UIUX
    When a member then creates a Checkpoint
    Then the timeline shows an external version with that change before the Checkpoint
    Then the external version names no member as its actor
