Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12) decision 7, option A, R32 and R33 https://github.com/DevilTea/uiux/discussions/130; accepted 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264; Discussion #241 R5 and owner clarification 2 (2026-10-18), the entry ships as Part 12 decision 7 option A https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014829; issue #128 https://github.com/DevilTea/uiux/issues/128.
  # Test: code@e33ca13 `tests/adapter-entry.test.ts#L59` "resolves for ESM importers and refuses every other module of the package" (the runtime exports, imported through a linked install). https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/tests/adapter-entry.test.ts#L59
  # Test: code@e33ca13 `tests/adapter-entry.test.ts#L85` "exports only the three string constants at runtime, which UIUX itself uses". https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/tests/adapter-entry.test.ts#L85
  # Test: code@e33ca13 `scripts/smoke-package.mjs#L87-L101` (the packed tarball, installed with npm). https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/scripts/smoke-package.mjs#L87-L101
  # Status: built as of e33ca13.
  @spec:id:01a14f85-c4ed-7bad-b61c-6b3b41d34583
  @spec:demonstrates:01a11a5a-472a-74f0-9d70-81a3b7f477a6
  Scenario: An Adapter reads the value-contract IDs and the Widget ID attribute from the authoring entry
    Given a project that installs the packed `@deviltea/uiux`
    When the project imports `@deviltea/uiux/adapter` at runtime
    Then the module provides exactly `TRANSLATION_RESULT_VALUE_CONTRACT_ID`, `STRING_VALUE_CONTRACT_ID` and `WIDGET_ID_ATTRIBUTE`
    Then each constant holds the string its Clause names
