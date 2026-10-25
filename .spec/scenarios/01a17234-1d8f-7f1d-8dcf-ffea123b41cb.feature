Feature: The Workbench lists pending Decisions across Views
  # Source: Owner rulings 2026-10-25 (#86 Decision lifecycle) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19175269.
  # Test: code@bd59929 `tests/decision-lifecycle-browser.test.ts#L110` "lists the pending Decision on the Overview and opens its View on the Spec tab". https://github.com/DevilTea/uiux/blob/bd5992961ff64a00a2697e7aa00022be773fe11c/tests/decision-lifecycle-browser.test.ts#L110
  # Status: built as of bd59929.
  @spec:id:01a17234-1d8f-79c5-a61a-7ae51475c7fe
  @spec:demonstrates:01a11544-5e41-79bd-8fb8-5a632bacdfaf
  @spec:demonstrates:01a11544-5f18-77ac-b89e-56ced4056f19
  Scenario: The Workbench lists pending Decisions across Views
    Given a View whose Spec holds a pending Decision and a decided one
    When a member opens the Decisions tab of the Overview
    When the member selects the listed Decision
    Then only the pending Decision is listed, with its View
    Then the Workbench opens that View on its Spec tab
