Feature: View Variants
  # Source: [#241 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, with these defaults](https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19343472); issue #52 https://github.com/DevilTea/uiux/issues/52.
  # Test: code@22da069 `tests/base-state-requests.test.ts#L301` "reads Unavailable and sends nothing when the generation did not declare it". https://github.com/DevilTea/uiux/blob/22da069374f746dd3c4d2827dc54bea1f73deffa/tests/base-state-requests.test.ts#L301
  # Status: built as of 22da069.
  @spec:id:01a19a9d-a4dd-7e3c-967a-ba28c1bd8198
  @spec:demonstrates:01a19a9b-3c4d-74cb-9695-ce20087e2188
  @spec:demonstrates:01a19a9d-a01a-72bd-9ea0-cad4e90ae7fc
  Scenario: The Base cell reads Unavailable when the generation did not declare the feature
    Given a Workbench Preview generation that did not declare `inspection.base-state` and a Variant that overrides a Button's `disabled`
    When the user selects the Button while that Variant is open
    Then the Workbench sends no `inspection.base-state.request`
    Then the Base cell of `disabled` reads Unavailable, not the Widget's authored default
