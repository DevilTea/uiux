Feature: Handoff readiness
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c6 d5 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815; #1 c175 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757819; #1 c168 d3 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18675483; #7 c9 d5 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Test: code@a021f9e `tests/handoff-closure.test.ts#L409` "blocks implementation-ready when review threads are unresolved, while still exporting coherent snapshot". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/handoff-closure.test.ts#L409
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d339-7660-8349-8e03e09f2d06
  @spec:demonstrates:01a115cd-c945-7a9e-b108-f0391086ca42
  @spec:demonstrates:01a115cd-c97b-7691-9d72-87d4016889d3
  @spec:demonstrates:01a115cd-caee-7be7-913e-0312303148f8
  @spec:demonstrates:01a115cd-d922-7728-a8f5-608889f8b510
  Scenario: An unresolved thread blocks implementation-ready, and the bundle still exports
    Given a View root with fresh, complete formal Evidence
    Given an open thread anchored to that View
    When an Editor exports a Handoff bundle for the View
    Then the bundle is exported with `implementationReady` false
    Then its blocking diagnostics include `handoff.unresolved_review_thread`
