Feature: Command line
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #1 body: CLI & Server https://github.com/DevilTea/uiux/discussions/1; #7 c5 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814; #7 c9 R17 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Test: code@a021f9e `tests/bootstrap.test.ts#L31` "initializes a minimal current-schema Workspace without overwriting an existing manifest". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/bootstrap.test.ts#L31
  # Test: code@d3bc3a3 `tests/workspace-migration.test.ts#L237` "initializes new Workspaces at the current schemaVersion, which migrate reports as already current". https://github.com/DevilTea/uiux/blob/d3bc3a3502315c0105f0cb2d3c2b5c9e43256fa5/tests/workspace-migration.test.ts#L237
  # Test: code@3b20412 `tests/cli-init.test.ts#L66` "creates the Workspace in <cwd>/.uiux/ outside a Git repository". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/cli-init.test.ts#L66
  # Test: code@3b20412 `tests/cli-init.test.ts#L82` "refuses an initialized Workspace, of either layout, and changes nothing". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/cli-init.test.ts#L82
  # Status: partly built as of 3b20412: `uiux init` writes `workspace.json` at `schemaVersion` 5, an empty `product-kit.json` and a `.gitignore`, but no Access presets file; see the Implementation gaps entry of 01a1144e-55a3-74c4-8bf8-3205e968e275 in its owner.
  @spec:id:01a118a1-dbef-7660-92f6-c0b2aaf8afa6
  @spec:demonstrates:01a1144e-55a3-74c4-8bf8-3205e968e275
  @spec:demonstrates:01a1144e-55be-785d-b494-7f7da834572a
  Scenario: Init creates a minimal current Workspace once
    Given a directory without a Workspace manifest
    When an operator runs `uiux init` on it twice
    Then the first run creates a manifest at the current `schemaVersion` with no Adapters and empty registries
    Then the second run is refused and leaves the manifest unchanged
