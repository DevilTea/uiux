Feature: Agent authoring over MCP
  # Source: Discussion #241 (Part 18), proposal and owner acceptance of the Review discovery summaries and filters (#84), 2026-10-22 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19123284; #7 c3 9b https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18674068.
  # Test: code@60faa31 `tests/review-discovery.test.ts#L293` "combines filters with AND, including resolution and anchorScope". https://github.com/DevilTea/uiux/blob/60faa31617269443d9f17474836a03583e499d94/tests/review-discovery.test.ts#L293
  # Test: code@60faa31 `tests/review-discovery.test.ts#L259` "narrows by each filter, and a Review filter excludes other kinds". https://github.com/DevilTea/uiux/blob/60faa31617269443d9f17474836a03583e499d94/tests/review-discovery.test.ts#L259
  # Test: code@60faa31 `tests/review-discovery.test.ts#L367` "serves the same filters and summaries over MCP". https://github.com/DevilTea/uiux/blob/60faa31617269443d9f17474836a03583e499d94/tests/review-discovery.test.ts#L367
  # Status: built as of 60faa31.
  @spec:id:01a163a5-b24b-7c49-bc3a-849cf1b4952f
  @spec:demonstrates:01a11544-53c4-7042-8e81-e381dd1d4450
  @spec:demonstrates:01a11544-6d38-7c63-958a-e0133b131fd3
  @spec:demonstrates:01a163a5-7110-79e8-94ac-887c8eddde6a
  Scenario: Review filters combine, and only Review threads match them
    Given a Workspace with a View, an open thread and a thread ready for review on that View, and a thread ready for review on another View
    When an Agent lists resources with `status` `ready-for-review` and `viewId` naming the first View
    Then only the thread ready for review on the first View is listed
