Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #7 c6 d7, d10 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815.
  # Test: code@a021f9e `tests/review-resolution-and-hints.test.ts#L92` "requires an explicit non-verified resolution on open threads and enforces the decided validation codes". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-resolution-and-hints.test.ts#L92
  # Status: built as of a021f9e.
  @spec:id:01a118a1-c9a2-7641-863b-1ff897f0da3d
  @spec:demonstrates:01a11544-5647-747f-bea3-5cd9d92241b8
  Scenario: Resolving an open thread needs an explicit resolution
    Given an open thread without a submission
    When a human Reviewer resolves it without naming a resolution
    Then the resolve is refused and the thread stays open
