Feature: Static publication
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c5 default R8: publication stays thread-free https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814; #1 c176 Problem: the static publication carries no Review threads; Out of scope https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18757820.
  # Status: not built as of a021f9e; see the Implementation gaps entry of 01a11485-f29e-7e71-a3b6-030a1dd80781 in its owner.
  # Note: No test asserts it; `scripts/smoke-publication.mjs` currently opens the published Reviews page, the opposite behavior (issue #70).
  @spec:id:01a118a1-d448-7643-a55c-cdbdcdb90a8f
  @spec:demonstrates:01a11485-f29e-7e71-a3b6-030a1dd80781
  Scenario: A publication carries no Review threads
    Given a Workspace with open and resolved Review threads
    When an operator builds its publication with `uiux publish`
    Then the published site contains no Review thread, thread ID or link to a thread
    Then its readiness shows only aggregate Review counts
