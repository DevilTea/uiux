Feature: Version history
  # Source: Discussion #122 (Part 11) d5 Changes outside UIUX https://github.com/DevilTea/uiux/discussions/122; "What `.spec/` records after acceptance" key Scenarios https://github.com/DevilTea/uiux/discussions/122#what-spec-records-after-acceptance; owner acceptance https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a5e-0313-7d86-af79-8eafa1753853 in its owner.
  # Note: No test exists yet; tracked in issue #132.
  @spec:id:01a11a5e-91d5-7576-9bc3-d0da98e93169
  @spec:demonstrates:01a11a5e-0313-7d86-af79-8eafa1753853
  @spec:demonstrates:01a11a5e-21c4-79f7-b6f9-4128d842c278
  Scenario: An edit made outside UIUX shows as an external version
    Given a running `uiux dev` server for a Workspace
    When a text editor changes a View file outside UIUX
    When a member then creates a checkpoint
    Then the timeline shows an external version with that change before the checkpoint
    Then the external version names no member as its actor
