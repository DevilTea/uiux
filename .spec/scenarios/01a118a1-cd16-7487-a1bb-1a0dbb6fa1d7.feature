Feature: Review messages and retraction
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c10 d5, T4, T5 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772501; #1 c179 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18772502.
  # Test: code@a021f9e `tests/review-retract.test.ts#L176` "lets an agent retract its own thread over MCP and refuses a human\". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-retract.test.ts#L176
  # Test: code@a021f9e `tests/review-retract.test.ts#L75` "lets the author hard-delete an unengaged thread: no file, no trace, then not_found". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-retract.test.ts#L75
  # Status: built as of a021f9e.
  @spec:id:01a118a1-cd16-78ac-a1d9-4ca6456d9665
  @spec:demonstrates:01a11544-598c-7217-8b56-7cb8ff0236da
  @spec:demonstrates:01a11544-5a55-7249-948f-4e136df52a63
  @spec:demonstrates:01a11544-5aa5-76bd-99a9-b8b9b0599a03
  Scenario: An Agent retracts its own unanswered thread
    Given an Agent opened a thread with one message
    Given nobody has replied to, re-anchored, submitted or promoted it
    When the Agent retracts the thread over MCP
    Then the thread file is removed without a trace in canonical state
    Then reading the thread reports it as not found
