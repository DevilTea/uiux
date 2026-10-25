Feature: A Flow read reports its invalid View, Variant and Widget references without changing them
  # Source: Discussion #6 c2 d7 https://github.com/DevilTea/uiux/discussions/6#discussioncomment-18673004; issue #88.
  # Test: code@b57e39d `tests/flow-references.test.ts#L63` "adds them to the point read and the list diagnostic count without changing the Flow". https://github.com/DevilTea/uiux/blob/b57e39d/tests/flow-references.test.ts#L63
  # Test: code@b57e39d `tests/flow-references.test.ts#L29` "reports a missing View, Variant and Widget at the reference path and keeps a valid reference silent". https://github.com/DevilTea/uiux/blob/b57e39d/tests/flow-references.test.ts#L29
  # Status: built as of b57e39d.
  @spec:id:01a1727b-5b8f-7876-825c-d6e28e7889e2
  @spec:demonstrates:01a11544-629c-7dbf-8e41-36c8e37537b3
  Scenario: A Flow read reports its invalid View, Variant and Widget references without changing them
    Given a UX Flow whose step targets a View that does not exist
    When an Agent reads or lists the Flow
    Then the Flow's diagnostics name the missing View at the step's reference
    Then the Flow is returned exactly as authored
