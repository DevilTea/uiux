Feature: An Agent expands list items on request and pages them as before
  # Source: Discussion #241, owner rulings 2026-10-23 on the discovery detail expansion (#78) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19136881; #1 c164 d4 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18671287; #7 c3 9b https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18674068.
  # Test: code@0cc4de6 `tests/resource-discovery-detail.test.ts#L219` "adds only a detail member when expanded, leaving the rest of each item unchanged". https://github.com/DevilTea/uiux/blob/0cc4de696d2384d36076d808f6c597b6ceef5e29/tests/resource-discovery-detail.test.ts#L219
  # Test: code@0cc4de6 `tests/resource-discovery-detail.test.ts#L230` "expands Views with Variant names, an intent excerpt, spec list counts and Decision counts (Clause 01a166bd-f310)". https://github.com/DevilTea/uiux/blob/0cc4de696d2384d36076d808f6c597b6ceef5e29/tests/resource-discovery-detail.test.ts#L230
  # Test: code@0cc4de6 `tests/resource-discovery-detail.test.ts#L250` "expands Flows, Locales and Assets (Clause 01a166bd-f4d9)". https://github.com/DevilTea/uiux/blob/0cc4de696d2384d36076d808f6c597b6ceef5e29/tests/resource-discovery-detail.test.ts#L250
  # Test: code@0cc4de6 `tests/resource-discovery-detail.test.ts#L262` "expands Review threads with counts, participants, a first-message excerpt and current evidence refs (Clause 01a166bd-f6ac)". https://github.com/DevilTea/uiux/blob/0cc4de696d2384d36076d808f6c597b6ceef5e29/tests/resource-discovery-detail.test.ts#L262
  # Test: code@0cc4de6 `tests/resource-discovery-detail.test.ts#L278` "pages the same with expansion, and a cursor carries over between summary and expanded". https://github.com/DevilTea/uiux/blob/0cc4de696d2384d36076d808f6c597b6ceef5e29/tests/resource-discovery-detail.test.ts#L278
  # Status: built as of 0cc4de6.
  @spec:id:01a166c4-23a0-7e5a-8d10-4e8dc28655d0
  @spec:demonstrates:01a166bd-ef89-7bdc-96a9-6eb86451932a
  @spec:demonstrates:01a166bd-f310-7e84-b1da-892a8b3c3873
  @spec:demonstrates:01a166bd-f4d9-7427-9b9a-881b61fe8b18
  @spec:demonstrates:01a166bd-f6ac-71d8-86c1-3494875a3e14
  Scenario: An Agent expands list items on request and pages them as before
    Given a Workspace with Views, a UX Flow, Locales, Review threads and an Asset
    When an Agent lists resources with `list_resources` and `detail` `expanded`, a page at a time
    Then each item carries the same summary as without `detail`, and a `detail` member with its kind's bounded projection
    Then the pages list the same items in the same order as without `detail`
    Then no item carries a View IR, a full message body, Locale messages or Asset content
