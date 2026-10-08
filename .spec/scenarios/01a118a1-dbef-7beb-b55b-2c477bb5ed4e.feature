Feature: Command line
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #1 body: CLI & Server https://github.com/DevilTea/uiux/discussions/1; #7 c5 d7 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18757814; #7 c9 R17 https://github.com/DevilTea/uiux/discussions/7#discussioncomment-18772095.
  # Test: code@a021f9e `tests/bootstrap.test.ts#L31` "initializes a minimal current-schema Workspace without overwriting an existing manifest". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/bootstrap.test.ts#L31
  # Test: code@a021f9e `tests/workspace-migration.test.ts#L221` "initializes new Workspaces at schemaVersion 3, which migrate reports as already current". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workspace-migration.test.ts#L221
  # Status: partly built as of 2f7e092: `uiux init` requires `--workspace` and writes a `.uiux/workspace.json` manifest at `schemaVersion` 3 with no Product Kit file; see the Implementation gaps entry of 01a1144e-55a3-74c4-8bf8-3205e968e275 in its owner.
  @spec:id:01a118a1-dbef-7660-92f6-c0b2aaf8afa6
  @spec:demonstrates:01a1144e-55a3-74c4-8bf8-3205e968e275
  @spec:demonstrates:01a1144e-55be-785d-b494-7f7da834572a
  Scenario: Init creates a minimal current Workspace once
    Given a directory without a Workspace manifest
    When an operator runs `uiux init` on it twice
    Then the first run creates a manifest at the current `schemaVersion` with no Adapters and empty registries
    Then the second run is refused and leaves the manifest unchanged
