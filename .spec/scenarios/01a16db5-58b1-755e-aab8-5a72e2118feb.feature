Feature: Review desk
  # Source: Discussion #241 owner ruling 4: Submit for review refuses a capture made stale by an Adapter or Product Kit change https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19162185.
  # Test: code@ecfd144 `tests/review-scope-and-edit.test.ts#L585` "refuses a capture whose Adapters or Product Kit changed since capture, and accepts a fresh one". https://github.com/DevilTea/uiux/blob/ecfd1442ab9c593406ce72bf5d88527b7b12cde3/tests/review-scope-and-edit.test.ts#L585
  # Status: built as of ecfd144.
  @spec:id:01a16db5-58b0-78b3-86d2-bce9025b8d4a
  @spec:demonstrates:01a11544-558b-7b86-b4c7-76928862c948
  @spec:demonstrates:01a115cd-3769-7376-ba43-a6b867d8cb85
  Scenario: Marking ready with Evidence captured before an Adapter or Product Kit change is refused
    Given an open thread on a View
    Given a formal capture of that View whose render-input digest still matches but whose recorded Adapter provenance differs from the current one
    When a member marks the thread ready for review citing that capture
    Then marking ready is refused with `review.formal_evidence_not_current`
    Then the thread stays open without a new submission
