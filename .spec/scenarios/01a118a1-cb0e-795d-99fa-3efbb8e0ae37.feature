Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c20 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18561691; #7 c9 d4 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R2: the capture predates an IR change, since the ready-for-review check follows the render-input digest https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804.
  # Test: code@959a7bd `tests/review-scope-and-edit.test.ts#L495` "refuses a capture taken before an IR change with review.formal_evidence_not_current and keeps the thread open". https://github.com/DevilTea/uiux/blob/959a7bda83b8c52086144fa9366d67b52e4fd0ce/tests/review-scope-and-edit.test.ts#L495
  # Test: code@959a7bd `tests/review-scope-and-edit.test.ts#L219` "requires the current manifest revision and makes every named View valid and current". https://github.com/DevilTea/uiux/blob/959a7bda83b8c52086144fa9366d67b52e4fd0ce/tests/review-scope-and-edit.test.ts#L219
  # Status: built as of 959a7bd.
  @spec:id:01a118a1-cb0e-7652-9217-db24913f0d37
  @spec:demonstrates:01a11544-558b-7b86-b4c7-76928862c948
  @spec:demonstrates:01a115cd-3769-7376-ba43-a6b867d8cb85
  Scenario: Marking ready with Evidence captured before an IR change is refused
    Given an open thread on a View
    Given a formal capture of that View taken before its IR changed
    When a member marks the thread ready for review citing that capture
    Then marking ready is refused with `review.formal_evidence_not_current`
    Then the thread stays open without a new submission
