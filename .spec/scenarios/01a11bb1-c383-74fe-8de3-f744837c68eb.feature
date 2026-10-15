Feature: Checks
  # Source: Discussion #139 (Part 14, Product Kit), decision 7: C2; R9; owner pre-answer P13; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Test: code@4723a02 `tests/product-kit-checks.test.ts#L178` "reports a component that copies a prop into local state as kit.state_not_controlled (Scenario c383)". https://github.com/DevilTea/uiux/blob/4723a02d5b95ad907f08a4891c4b514d95585c66/tests/product-kit-checks.test.ts#L178
  # Test: code@4723a02 `tests/product-kit-checks.test.ts#L236` "shows each check's state and the Product Kit findings in Overview › Checks after Run Checks". https://github.com/DevilTea/uiux/blob/4723a02d5b95ad907f08a4891c4b514d95585c66/tests/product-kit-checks.test.ts#L236
  # Status: built as of 4723a02.
  @spec:id:01a11bb1-c383-779a-9ce6-2ca1bf7448ee
  @spec:demonstrates:01a11bb1-8980-7212-acad-4145928e5dc7
  @spec:demonstrates:01a11bb1-8d03-7751-9173-b3c3f1ab7156
  @spec:demonstrates:01a11bb1-a7bf-74ae-9639-b39f246fa117
  Scenario: A prop copied into local state is reported as not controlled
    Given a registry component that copies a prop into local state when it mounts
    Given a View whose Variant sets the State that its wrapper passes as that prop
    When Checks compares the live Preview of that Variant with a fresh Runtime of it
    Then Checks reports `kit.state_not_controlled` for the component as a non-blocking finding
