Feature: Adapter selection and resolution
  # Source: Discussion #139 (Part 14, Product Kit), decision 6, A; R8; owner pre-answer P14; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 9691b8c; see the Implementation gaps entry of 01a11bb1-acdc-799f-aed7-c85ddbaf0d28 in its owner.
  # Note: No test exists yet; tracked in issue #141.
  @spec:id:01a11bb1-c318-76ba-b849-1a9050d129c9
  @spec:demonstrates:01a11bb1-acdc-799f-aed7-c85ddbaf0d28
  @spec:demonstrates:01a11bb1-ad41-761c-ad47-a0e7ed5b8240
  Scenario: A component library that imports its CSS from JavaScript renders styled
    Given a kit whose wrapper entry uses a Vue component library that imports its CSS from JavaScript
    When a View that uses a component of that library opens in the Preview
    Then the component renders with the library's styles from the Product Kit stylesheet
