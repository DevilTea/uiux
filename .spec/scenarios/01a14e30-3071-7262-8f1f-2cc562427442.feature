Feature: Evidence freshness
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R2: a Spec-only edit leaves the View's Evidence fresh https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Status: not built as of 3477f81: a Spec-only edit changes the View revision, which makes the capture stale; see the Implementation gaps entries of 01a115cd-c5a5-757a-b049-b5138fe75920 and 01a115cd-c749-7a82-bf67-7d1634e31b35 in their owner.
  # Note: No test exists yet.
  @spec:id:01a14e30-3071-774a-bdc4-61ff3c92e303
  @spec:demonstrates:01a115cd-c5a5-757a-b049-b5138fe75920
  @spec:demonstrates:01a115cd-c749-7a82-bf67-7d1634e31b35
  Scenario: A Spec-only edit keeps a View's Evidence fresh
    Given a View root captured with complete formal Evidence
    When an Editor changes only the View's Spec
    When an Editor exports a Handoff bundle for it
    Then the bundle includes the earlier capture as fresh
