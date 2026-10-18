Feature: Evidence freshness
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R2: a Spec-only edit leaves the View's Evidence fresh https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Test: code@959a7bd `tests/handoff-closure.test.ts#L1029` "keeps evidence fresh in readiness and export after a Spec-only or metadata edit of its View". https://github.com/DevilTea/uiux/blob/959a7bda83b8c52086144fa9366d67b52e4fd0ce/tests/handoff-closure.test.ts#L1029
  # Test: code@959a7bd `tests/evidence-staleness.test.ts#L88` "stays fresh after a Spec-only or metadata edit of its View". https://github.com/DevilTea/uiux/blob/959a7bda83b8c52086144fa9366d67b52e4fd0ce/tests/evidence-staleness.test.ts#L88
  # Status: built as of 959a7bd.
  @spec:id:01a14e30-3071-774a-bdc4-61ff3c92e303
  @spec:demonstrates:01a115cd-c5a5-757a-b049-b5138fe75920
  @spec:demonstrates:01a115cd-c749-7a82-bf67-7d1634e31b35
  Scenario: A Spec-only edit keeps a View's Evidence fresh
    Given a View root captured with complete formal Evidence
    When an Editor changes only the View's Spec
    When an Editor exports a Handoff bundle for it
    Then the bundle includes the earlier capture as fresh
