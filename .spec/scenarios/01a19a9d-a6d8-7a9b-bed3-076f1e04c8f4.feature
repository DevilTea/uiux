Feature: View Variants
  # Source: [#241 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, with these defaults](https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19343472); issue #52 https://github.com/DevilTea/uiux/issues/52.
  # Status: Not built as of 4e0209e (issue #52).
  @spec:id:01a19a9d-a6d8-723a-9bd0-21f134ace604
  @spec:demonstrates:01a19a9b-3c4d-74cb-9695-ce20087e2188
  @spec:demonstrates:01a19a9d-a01a-72bd-9ea0-cad4e90ae7fc
  Scenario: The Base cell reads Unavailable when the runtime does not answer in time
    Given a Workbench Preview generation that declared `inspection.base-state` whose runtime never answers an `inspection.base-state.request`
    When the user selects a Widget that the open Variant overrides and 5000 ms pass
    Then the Base cell of each overridden State member reads Unavailable
    Then a response of that request arriving later changes no Base cell
