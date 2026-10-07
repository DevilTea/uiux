Feature: Review desk
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #7 c6 d3 rules 3-7, R4 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757815.
  # Test: code@a021f9e `tests/review-schema-v2.test.ts#L56` "requires a non-empty reason for duplicate only". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-schema-v2.test.ts#L56
  # Test: code@a021f9e `tests/review-v3-browser.test.ts#L364` "asks for Duplicate\". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/review-v3-browser.test.ts#L364
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d5d6-7c9c-8a7f-fad68fad0e5c
  @spec:demonstrates:01a115cd-3627-7dcf-9748-b01b04ada02f
  Scenario: Resolving as duplicate needs a reason
    Given an open thread
    When a human Reviewer resolves it as duplicate without a reason
    Then the resolve is refused with `review.resolution_reason_required`
