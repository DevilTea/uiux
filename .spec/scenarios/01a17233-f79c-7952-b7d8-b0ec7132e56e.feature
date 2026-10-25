Feature: An Agent cannot decide a Decision
  # Source: Owner rulings 2026-10-25 (#86 Decision lifecycle) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19175269.
  # Test: code@bd59929 `tests/decision-lifecycle.test.ts#L198` "lets only a human Workbench session with decisions.decide decide, and views.write defer and reopen". https://github.com/DevilTea/uiux/blob/bd5992961ff64a00a2697e7aa00022be773fe11c/tests/decision-lifecycle.test.ts#L198
  # Test: code@bd59929 `tests/decision-lifecycle.test.ts#L236` "lists the three tools, runs defer and reopen as an Agent, refuses decide, and records write events". https://github.com/DevilTea/uiux/blob/bd5992961ff64a00a2697e7aa00022be773fe11c/tests/decision-lifecycle.test.ts#L236
  # Status: built as of bd59929.
  @spec:id:01a17233-f79c-7df5-a9d1-2b45bc8cb4c1
  @spec:demonstrates:01a11544-5e99-789d-bfed-dda22a98776f
  @spec:demonstrates:01a17226-f9d8-7fe9-ac7c-549177becb02
  Scenario: An Agent cannot decide a Decision
    Given an Agent holding every key that is not humanOnly
    Given a View whose Spec holds a pending Decision
    When the Agent calls decide_decision over MCP
    Then the call is refused with auth.scope_denied naming decisions.decide
    Then the Decision stays pending
