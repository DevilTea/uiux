Feature: Handoff export
  # Source: Discussion #139 (Part 14, Product Kit), decision 10, A; R13; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 2f7e092; see the Implementation gaps entry of 01a11bb1-bde1-7146-abc4-31a3e7f4e371 in its owner.
  # Note: No test exists yet; tracked in issue #141.
  @spec:id:01a11bb1-c2b2-7e8c-a058-29a8320af7ff
  @spec:demonstrates:01a11bb1-bbed-7588-bce6-5e1f4f0bcf72
  @spec:demonstrates:01a11bb1-bde1-7146-abc4-31a3e7f4e371
  Scenario: Handoff names the mapped registry component with its digest
    Given a component table that maps the Widget type `OrderSummary` to the registry component `order-summary-card`
    When an Editor exports a Handoff bundle rooted at a View that uses `OrderSummary`
    Then the implementation reference of `OrderSummary` names `order-summary-card` with its component digest and the command `uiux components add order-summary-card`
