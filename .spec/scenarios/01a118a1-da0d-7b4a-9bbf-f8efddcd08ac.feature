Feature: Handoff readiness
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #7 c6 d5 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815; #1 c175 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757819; #7 c10 T14 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772501.
  # Test: code@a021f9e `tests/handoff-closure.test.ts#L463` "reports per-resolution review counts, never blocks on closed threads, and flags wont-fix as advisory only". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/handoff-closure.test.ts#L463
  # Test: code@a021f9e `tests/readiness-browser.test.ts#L77` "splits blocking from advisory: a declined Review never counts as a blocker". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/readiness-browser.test.ts#L77
  # Status: built as of a021f9e.
  @spec:id:01a118a1-da0d-7e87-b1c8-9c0a3de39e25
  @spec:demonstrates:01a115cd-caee-7be7-913e-0312303148f8
  @spec:demonstrates:01a115cd-cb5e-760e-a74b-fedba2262f37
  Scenario: A won't-fix thread is an advisory, not a blocker
    Given a View root with fresh, complete formal Evidence whose only thread is resolved as won't-fix
    When an Editor assesses Handoff readiness for that root
    Then the assessment claims implementation-ready
    Then it lists the advisory `handoff.review_declined` for the thread
