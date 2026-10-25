Feature: A Flow with a reference diagnostic is not captured as Flow Evidence
  # Source: Discussion #241 owner rulings 2026-10-25 (#88 Flows on the server) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19177134, items 4-6.
  # Test: code@0a5478e `tests/flow-evidence.test.ts#L159` "refuses to capture a Flow with a reference diagnostic, before any browser runs, and records nothing". https://github.com/DevilTea/uiux/blob/0a5478e/tests/flow-evidence.test.ts#L159
  # Test: code@0a5478e `tests/flow-evidence.test.ts#L178` "keeps the formal captures a failed run already recorded, and records no trace". https://github.com/DevilTea/uiux/blob/0a5478e/tests/flow-evidence.test.ts#L178
  # Test: code@0a5478e `tests/flow-evidence.test.ts#L200` "writes nothing for a member without evidence.capture". https://github.com/DevilTea/uiux/blob/0a5478e/tests/flow-evidence.test.ts#L200
  # Status: built as of 0a5478e.
  @spec:id:01a172d3-f2bd-70d0-a402-973a749b62d6
  @spec:demonstrates:01a11544-62c8-7d37-933b-b991fed72e30
  @spec:demonstrates:01a172cc-e195-711b-bfa9-5de6c1c8ff87
  Scenario: A Flow with a reference diagnostic is not captured as Flow Evidence
    Given a UX Flow whose step names a Variant its View does not have
    When an Agent captures formal Flow Evidence for the Flow
    Then the capture is refused with the Flow's diagnostics and no browser runs
    Then nothing is recorded
