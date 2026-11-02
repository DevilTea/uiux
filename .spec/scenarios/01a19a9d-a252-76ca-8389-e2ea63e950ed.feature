Feature: View Variants
  # Source: [#241 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, with these defaults](https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19343472); issue #52 https://github.com/DevilTea/uiux/issues/52.
  # Status: Not built as of 4e0209e (issue #52).
  @spec:id:01a19a9d-a252-7262-aa4c-04b23ea2f65a
  @spec:demonstrates:01a19a9b-308e-7377-ac04-54b81a96e5ed
  @spec:demonstrates:01a19a9d-9d1b-7db9-a535-96dedc258395
  @spec:demonstrates:01a19a9d-a01a-72bd-9ea0-cad4e90ae7fc
  Scenario: The Inspector shows a Variant override beside its base-state value
    Given a Workbench Preview generation that declared `inspection.base-state` and a Variant that overrides a Button's `disabled` to true
    When the user selects the Button while that Variant is open
    Then the Workbench sends `inspection.base-state.request` with the key `disabled` and the open View and Variant
    Then the Inspector shows true under the Variant column and, under Base, the `disabled` value of the View without the Variant
