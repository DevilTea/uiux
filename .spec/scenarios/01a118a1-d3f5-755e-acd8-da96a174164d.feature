Feature: Handoff readiness
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c168 d1: selected formal evidence https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18675483; #1 c169 required evidence https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18675610; #1 c159 d3 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18660618.
  # Test: code@a021f9e `tests/handoff-closure.test.ts#L965` "excludes stale evidence from readiness and export when View revision changes (r1 -> r2 regression)". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/handoff-closure.test.ts#L965
  # Test: code@a021f9e `tests/handoff-closure.test.ts#L537` "blocks implementation-ready when formal evidence is missing or incomplete". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/handoff-closure.test.ts#L537
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d3f5-7ea8-875c-6ddf0ec00602
  @spec:demonstrates:01a115cd-c5a5-757a-b049-b5138fe75920
  @spec:demonstrates:01a115cd-ca1a-75ec-b635-df569c795be8
  @spec:demonstrates:01a115cd-ca50-70b3-a65c-bd1c9f74aba4
  Scenario: A View changed after capture needs new Evidence before it is ready
    Given a View root captured with complete formal Evidence at one revision
    When the View changes to a new revision
    When an Editor exports a Handoff bundle for it
    Then the earlier capture is left out of the bundle as stale
    Then the bundle does not claim implementation-ready
