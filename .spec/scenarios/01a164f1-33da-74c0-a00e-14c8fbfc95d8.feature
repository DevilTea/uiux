Feature: Mutation results
  # Source: Discussion #241 comment (2026-10-23), "Owner rulings 2026-10-23 (#77 change summary in mutation results)", rulings 1 and 3 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19130600; #1 c164 d4 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18671287.
  # Test: code@be236ef `tests/mutation-change-summary.test.ts#L274` "carries the same summary for every authoring kind on both transports". https://github.com/DevilTea/uiux/blob/be236ef4ba30f176a40aff50eca3978168a400d5/tests/mutation-change-summary.test.ts#L274
  # Status: built as of be236ef.
  @spec:id:01a164f1-33da-7dec-a52e-a2bd59a4b6e9
  @spec:demonstrates:01a11485-f578-79a7-9d01-4bc233f2c1cb
  @spec:demonstrates:01a164f0-c0fe-7c86-9c50-cc9354e49fe8
  @spec:demonstrates:01a164f0-c7a4-7ec9-aa1e-71dfb5f26b53
  Scenario: A View rename reports only the changed member
    Given an Agent member holding `views.write` connected to `/mcp`
    Given an existing View
    When the Agent renames the View with `update_view_metadata` and its current revision
    Then the result carries `changeSummary` with the single change `{ path: "/name", op: "replace" }`
    Then the same rename over HTTP returns the same `changeSummary`
