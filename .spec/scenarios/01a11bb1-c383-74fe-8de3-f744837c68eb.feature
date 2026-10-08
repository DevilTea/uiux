Feature: Checks
  # Source: Discussion #139 (Part 14, Product Kit), decision 7: C2; R9; owner pre-answer P13; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 9691b8c; see the Implementation gaps entry of 01a11bb1-a7bf-74ae-9639-b39f246fa117 in its owner.
  # Note: No test exists yet; tracked in issue #141.
  @spec:id:01a11bb1-c383-779a-9ce6-2ca1bf7448ee
  @spec:demonstrates:01a11bb1-8980-7212-acad-4145928e5dc7
  @spec:demonstrates:01a11bb1-8d03-7751-9173-b3c3f1ab7156
  @spec:demonstrates:01a11bb1-a7bf-74ae-9639-b39f246fa117
  Scenario: A prop copied into local state is reported as not controlled
    Given a registry component that copies a prop into local state when it mounts
    Given a View whose Variant sets the State that its wrapper passes as that prop
    When Checks compares the live Preview of that Variant with a fresh Runtime of it
    Then Checks reports `kit.state_not_controlled` for the component as a non-blocking finding
