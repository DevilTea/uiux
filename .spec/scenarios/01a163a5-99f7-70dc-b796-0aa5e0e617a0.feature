Feature: Agent authoring over MCP
  # Source: Discussion #241 (Part 18), proposal and owner acceptance of the Review discovery summaries and filters (#84), 2026-10-22 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19123284; #7 c3 9b https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18674068.
  # Test: code@60faa31 `tests/review-discovery.test.ts#L198` "carries the latest message with a 200-grapheme excerpt and the current submission, and nothing more of the thread". https://github.com/DevilTea/uiux/blob/60faa31617269443d9f17474836a03583e499d94/tests/review-discovery.test.ts#L198
  # Test: code@60faa31 `tests/review-discovery.test.ts#L232` "judges a reopen by its position in history, even when its time equals the submission time". https://github.com/DevilTea/uiux/blob/60faa31617269443d9f17474836a03583e499d94/tests/review-discovery.test.ts#L232
  # Test: code@60faa31 `tests/review-discovery.test.ts#L367` "serves the same filters and summaries over MCP". https://github.com/DevilTea/uiux/blob/60faa31617269443d9f17474836a03583e499d94/tests/review-discovery.test.ts#L367
  # Status: built as of 60faa31.
  @spec:id:01a163a5-99f6-766e-a687-dd23574ee007
  @spec:demonstrates:01a11544-537b-788e-8713-76f9a9ce705b
  @spec:demonstrates:01a163a5-719e-789d-a0fb-fc08646ed1d8
  Scenario: A Review list item summarizes its latest message and current submission
    Given a Workspace with a thread ready for review whose last message is longer than 200 grapheme clusters
    When an Agent lists Review threads with `list_resources`
    Then the thread summary carries `latestMessage` whose `excerpt` is the first 200 grapheme clusters of that message
    Then the thread summary carries `currentSubmission` with the `id`, `at` and `changeDomains` of its latest submission
