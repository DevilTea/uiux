Feature: Requirement references
  # Source: Discussion #379 (closed loop) [#379 body: P3: Where](https://github.com/DevilTea/uiux/discussions/379) and [#379 body: Risks: A Kit change stales all Evidence](https://github.com/DevilTea/uiux/discussions/379); owner acceptance 2026-10-28 https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19234465; scenario chosen in its `.spec/` PR.
  # Status: not built; tracked in issue #382 (https://github.com/DevilTea/uiux/issues/382).
  @spec:id:01a18121-7d2b-70b0-8ff5-579948a687a1
  @spec:demonstrates:01a14e30-2d4a-7ce9-ad68-58db56f36f47
  @spec:demonstrates:01a18121-00a2-7263-a1e6-3729863eb0f6
  Scenario: Editing only a Variant's requirement references keeps Evidence fresh
    Given a View with a fresh formal capture
    When an Agent changes only the `requirements` of one of its Variants
    Then the View's render-input digest is unchanged
    Then the formal capture is still fresh
