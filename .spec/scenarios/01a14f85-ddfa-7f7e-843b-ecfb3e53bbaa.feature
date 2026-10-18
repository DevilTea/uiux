Feature: Adapter selection and resolution
  # Source: Discussion #130 (Part 12) decision 7, option A: `exports` gains `./adapter` and `./package.json`, closing undocumented deep imports of `src/` https://github.com/DevilTea/uiux/discussions/130; accepted 2026-10-08 https://github.com/DevilTea/uiux/discussions/130#discussioncomment-18807264; issue #128 https://github.com/DevilTea/uiux/issues/128.
  # Test: code@e33ca13 `tests/adapter-entry.test.ts#L49` "is the only subpath the exports map exposes, besides package.json". https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/tests/adapter-entry.test.ts#L49
  # Test: code@e33ca13 `tests/adapter-entry.test.ts#L59` "resolves for ESM importers and refuses every other module of the package". https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/tests/adapter-entry.test.ts#L59
  # Test: code@e33ca13 `tests/adapter-entry.test.ts#L138` "exports the Adapter author types that a minimal third-party Adapter type-checks against" (a deep type import of `src/` does not resolve). https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/tests/adapter-entry.test.ts#L138
  # Test: code@e33ca13 `scripts/smoke-package.mjs#L87-L101` (the packed tarball, installed with npm). https://github.com/DevilTea/uiux/blob/e33ca1313840ad68836a1c98f7945292e8b69886/scripts/smoke-package.mjs#L87-L101
  # Status: built as of e33ca13.
  @spec:id:01a14f85-ddf9-7eb9-a121-8081937b12a1
  @spec:demonstrates:01a11a5a-462c-7f59-af78-6d01787a275f
  Scenario: Only the authoring entry of the package can be imported
    Given a project that installs the packed `@deviltea/uiux`
    When the project imports the package root or a module under `@deviltea/uiux/src/`
    Then module resolution refuses the import because the package does not export that path
