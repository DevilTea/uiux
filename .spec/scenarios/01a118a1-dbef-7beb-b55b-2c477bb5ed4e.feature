Feature: Command line
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #1 body: CLI & Server https://github.com/DevilTea/uiux/discussions/1; #7 c5 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814; #7 c9 R17 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Test: code@a021f9e `tests/bootstrap.test.ts#L31` "initializes a minimal current-schema Workspace without overwriting an existing manifest". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/bootstrap.test.ts#L31
  # Test: code@3b20412 `tests/cli-init.test.ts#L66` "creates the Workspace in <cwd>/.uiux/ outside a Git repository". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/cli-init.test.ts#L66
  # Test: code@3b20412 `tests/cli-init.test.ts#L82` "refuses an initialized Workspace, of either layout, and changes nothing". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/cli-init.test.ts#L82
  # Test: code@39e99da `tests/access-presets.test.ts#L147` "writes the presets file in a new Workspace". https://github.com/DevilTea/uiux/blob/39e99da86eec36860acb97077deddd836cce9a33/tests/access-presets.test.ts#L147
  # Test: code@7f83900 `tests/cli-init.test.ts#L72` "creates the Workspace in <cwd>/.uiux/ outside a Git repository" (its `i18n/en-US.json` holds `{}` and `i18n.missing_default_locale` does not block it). https://github.com/DevilTea/uiux/blob/7f83900e7b17b8838f9b31d29c560472d63aac4a/tests/cli-init.test.ts#L72
  # Test: code@7f83900 `tests/cli-init.test.ts#L123` "refuses an existing default-Locale file, or an i18n entry that is not a directory, before writing anything". https://github.com/DevilTea/uiux/blob/7f83900e7b17b8838f9b31d29c560472d63aac4a/tests/cli-init.test.ts#L123
  # Test: code@ad0fc2e `tests/cli-init.test.ts#L42` "expectInitialized: the manifest `uiux init` writes holds `schemaVersion` 7". https://github.com/DevilTea/uiux/blob/ad0fc2e54bc67c53d74b3b94becbf0caeec92ee4/tests/cli-init.test.ts#L42
  # Status: built as of ad0fc2e: `uiux init` writes `workspace.json` at the current `schemaVersion` 7 ([#379 owner rulings 2026-10-28 (review of #384): ruling 4](https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19236211), issue #382 (https://github.com/DevilTea/uiux/issues/382)), an empty `product-kit.json`, an `access-presets.json` holding the built-in Access presets, the empty default-Locale file `i18n/en-US.json` (owner ruling 2 of https://github.com/DevilTea/uiux/issues/94#issuecomment-6218608568) and a `.gitignore`.
  @spec:id:01a118a1-dbef-7660-92f6-c0b2aaf8afa6
  @spec:demonstrates:01a1144e-55a3-74c4-8bf8-3205e968e275
  @spec:demonstrates:01a1144e-55be-785d-b494-7f7da834572a
  Scenario: Init creates a minimal current Workspace once
    Given a directory without a Workspace manifest
    When an operator runs `uiux init` on it twice
    Then the first run creates a manifest at the current `schemaVersion` with no Adapters and empty registries
    Then the second run is refused and leaves the manifest unchanged
