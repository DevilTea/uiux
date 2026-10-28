Feature: Formal UX Flow Evidence
  # Source: [#379 owner rulings 2026-10-28 (review of #384): ruling 2](https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19236211); owner acceptance 2026-10-28 https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19234465.
  # Status: not built; tracked in issue #382 (https://github.com/DevilTea/uiux/issues/382).
  @spec:id:01a1814f-8368-7352-a4c8-22b7128356a0
  @spec:demonstrates:01a18121-00a2-7263-a1e6-3729863eb0f6
  @spec:demonstrates:01a1814f-81c2-7c7a-93c8-1beecd1c5740
  @spec:demonstrates:01a1814f-8256-7927-92d9-b3d2ba9e5719
  Scenario: Editing only a Flow's requirement references keeps its trace fresh
    Given a Flow with a fresh flow_trace record
    When an Agent changes only the `requirements` of the Flow
    Then the Flow's input digest is unchanged
    Then the flow_trace is still fresh
