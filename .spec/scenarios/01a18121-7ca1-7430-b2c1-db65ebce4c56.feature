Feature: Requirement references
  # Source: Discussion #379 (closed loop) [#379 body: P3: Shape and validation](https://github.com/DevilTea/uiux/discussions/379); owner acceptance 2026-10-28 https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19234465; scenario chosen in its `.spec/` PR.
  # Test: code@ad0fc2e `tests/requirement-references.test.ts#L477` "keeps an ID the provider lacks as written, reports requirements.unresolved in the write result and lists it as unresolved". https://github.com/DevilTea/uiux/blob/ad0fc2e54bc67c53d74b3b94becbf0caeec92ee4/tests/requirement-references.test.ts#L477
  # Status: built as of ad0fc2e.
  @spec:id:01a18121-7ca1-7951-ae10-4846d9550a98
  @spec:demonstrates:01a18120-f5b9-75e2-83a6-8048dc5d6fba
  @spec:demonstrates:01a18120-fbc4-7edc-aa2e-f77f94603545
  Scenario: An ID the provider lacks is kept and reported
    Given a Workspace with a `spec` provider
    When an Agent updates a View's Spec with a requirement ID that the provider does not have
    Then the write succeeds and its result reports `requirements.unresolved` for that ID
    Then the View's Spec still lists the ID as written
