Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12) decision 7, option A: the exported types, defined once in the entry; type-only imports from the peer packages; Interactions 1 https://github.com/DevilTea/uiux/discussions/130; accepted 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264; issue #128 https://github.com/DevilTea/uiux/issues/128.
  # Test: code@e33ca13 `tests/adapter-entry.test.ts#L138` "exports the Adapter author types that a minimal third-party Adapter type-checks against" (the Adapter is `tests/fixtures/adapter-consumer/adapter.ts`, checked with `skipLibCheck: false`). https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/tests/adapter-entry.test.ts#L138
  # Test: code@e33ca13 `tests/adapter-entry.test.ts#L95` "ships an ESM module that imports nothing, and declarations that import types only from the peer packages". https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/tests/adapter-entry.test.ts#L95
  # Test: code@e33ca13 `tests/adapter-entry.test.ts#L112` "declares exactly the listed types and constants, and no value naming the host API version". https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/tests/adapter-entry.test.ts#L112
  # Test: code@e33ca13 `scripts/smoke-package.mjs#L71-L86` (the same Adapter against the packed tarball, installed with npm). https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/scripts/smoke-package.mjs#L71-L86
  # Status: built as of e33ca13.
  @spec:id:01a14f85-f10d-7b25-8c30-03fd46da8261
  @spec:demonstrates:01a11a5a-46ac-75d1-99a4-1b06c8480028
  @spec:demonstrates:01a11a5a-47bf-7a84-acc5-5ac420b500b1
  Scenario: A minimal Adapter type-checks against the authoring entry and its peer packages alone
    Given a project that installs the packed `@deviltea/uiux`
    Given an Adapter module that imports only `@deviltea/uiux/adapter`, `@deviltea/widget-core`, `@deviltea/widget-vue` and `vue`
    When TypeScript checks the module with library checking on
    Then its manifest, Catalog, i18n mapping, provider context and translation types check without errors
    Then an `apiVersion` outside version 1 and a warning code outside the closed union are type errors
