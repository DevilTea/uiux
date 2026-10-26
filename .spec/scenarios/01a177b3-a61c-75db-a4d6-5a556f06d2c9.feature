Feature: A Review submission names the Flow change domain and cites a Flow trace
  # Source: Discussion #6 comment 3 (2026-09-30), 10a https://github.com/DevilTea/uiux/discussions/6#discussioncomment-18673622; issue #88. Discussion #241 owner confirmations on PR #243 (B1), the change domain `flow` https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #88.
  # Test: code@8c77b6e `tests/flow-trace-review.test.ts#L34` "accepts the citation, maps the change to the Flow Evidence of its Flows, and leaves judging the trace to its freshness". https://github.com/DevilTea/uiux/blob/8c77b6e/tests/flow-trace-review.test.ts#L34
  # Status: built as of 8c77b6e.
  @spec:id:01a177b3-a61c-780d-b6ce-8d41fe1c1f8c
  @spec:demonstrates:01a11544-6760-7ec2-8430-0f7cc5807259
  Scenario: A Review submission names the Flow change domain and cites a Flow trace
    Given a Review thread and a flow_trace record of a Flow
    When an Agent submits it for review with the flow change domain, the Flow and the trace
    Then the submission is accepted with the trace as an Evidence reference
    Then the change affects the Flow Evidence of that Flow only
