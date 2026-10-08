Feature: Workspace migration
  # Source: Discussion #139 (Part 14, Product Kit), decision 15, A: step (2); R18; owner pre-answer P16; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 2f7e092; see the Implementation gaps entry of 01a11bb1-9658-7f9e-972e-bd09136a5735 in its owner.
  # Note: No test exists yet; tracked in issue #141.
  @spec:id:01a11bb1-bfe7-7a7e-b595-d80654a146be
  @spec:demonstrates:01a11bb1-9658-7f9e-972e-bd09136a5735
  Scenario: An Adapter outside the kit project makes the migration refuse
    Given an old-layout Workspace whose Adapter list selects `./adapters/reference.ts`
    When an operator runs `uiux migrate` on it
    Then the migration is refused with a list naming `./adapters/reference.ts`
    Then no file of the Workspace has changed
