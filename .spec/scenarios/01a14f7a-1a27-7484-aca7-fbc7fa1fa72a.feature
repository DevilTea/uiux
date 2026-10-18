Feature: Command-line interface
  # Source: Discussion #241 (Part 18, owner rulings 2026-10-18), R3 https://github.com/DevilTea/uiux/discussions/241; accepted 2026-10-18 https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19014804; owner confirmations A2: `uiux artifacts gc` refuses a Workspace that a running `uiux dev` server holds https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19015368; issue #58 https://github.com/DevilTea/uiux/issues/58.
  # Test: code@884a5d1 `tests/artifacts-gc.test.ts#L378` "refuses, deleting nothing, a Workspace that a running uiux dev server holds". https://github.com/DevilTea/uiux/blob/884a5d1c56b25a2fe67a3312a35ca5e1e54b7980/tests/artifacts-gc.test.ts#L378
  # Status: built as of 4fc05a7.
  # Note: The test writes the server hold of a live process on this host, as `uiux dev` does (`.server-hold.json`); a hold whose process is gone is stale and does not refuse.
  @spec:id:01a14f7a-1a27-730e-929c-59e9fe8ec7f7
  @spec:demonstrates:01a14e30-314b-7ee5-b85e-c8a926013beb
  Scenario: Artifact cleanup refuses a Workspace that a running server holds
    Given a Workspace whose artifact store holds a blob that no root reaches
    Given a running `uiux dev` server holds that Workspace
    When an operator runs `uiux artifacts gc` on it, with or without `--dry-run`
    Then the command exits with status 1 and its message names the server's process and host
    Then it prints no blob identity and the blob is still in the store
