Feature: Handoff readiness
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c169 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18675610.
  # Test: code@a021f9e `tests/handoff-closure.test.ts#L374` "ensures closure isolation: unrelated invalid resource outside closure does not block export or readiness". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/handoff-closure.test.ts#L374
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d39b-741a-8a39-14bae7bf0508
  @spec:demonstrates:01a115cd-c9b0-7712-84fe-558740320b05
  Scenario: A broken resource outside the closure does not affect readiness
    Given a valid, reviewed View root with fresh, complete formal Evidence
    Given an unrelated invalid resource elsewhere in the Workspace
    When an Editor assesses Handoff readiness for that root
    Then the assessment claims implementation-ready
