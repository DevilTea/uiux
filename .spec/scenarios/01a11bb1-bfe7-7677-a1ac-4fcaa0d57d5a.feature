Feature: Workspace migration
  # Source: Discussion #139 (Part 14, Product Kit), decision 15, A: step (2); R18; owner pre-answer P16; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Test: code@77d9d59 `tests/workspace-relocation.test.ts#L301` "lists every ./ Adapter outside .uiux/kit/ with its exact replacement, in a dry run and a real run, and writes nothing, not even the Checkpoint". https://github.com/DevilTea/uiux/blob/77d9d592cef041c7587b2586df2872532bf074a7/tests/workspace-relocation.test.ts#L301
  # Status: partly built as of 77d9d59: the refusal is built but dormant until UIUX switches to `schemaVersion` 5; see the Implementation gaps entry of 01a11bb1-9658-7f9e-972e-bd09136a5735 in its owner.
  @spec:id:01a11bb1-bfe7-7a7e-b595-d80654a146be
  @spec:demonstrates:01a11bb1-9658-7f9e-972e-bd09136a5735
  Scenario: An Adapter outside the kit project makes the migration refuse
    Given an old-layout Workspace whose Adapter list selects `./adapters/reference.ts`
    When an operator runs `uiux migrate` on it
    Then the migration is refused with a list naming `./adapters/reference.ts`
    Then no file of the Workspace has changed
