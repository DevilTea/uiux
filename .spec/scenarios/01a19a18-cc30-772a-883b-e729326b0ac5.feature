Feature: Command-line interface
  # Source: [#379 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, option A with these defaults](https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19341867); issue #466 https://github.com/DevilTea/uiux/issues/466.
  # Test: code@d0c23e4 `tests/cli-evidence-server.test.ts#L180` "refuses a Token the server does not accept and a member without evidence.capture, capturing nothing". https://github.com/DevilTea/uiux/blob/d0c23e4e281d0c080e2808438f933372724e99bf/tests/cli-evidence-server.test.ts#L180
  # Status: built as of d0c23e4.
  @spec:id:01a19a18-cc30-711a-9de3-26d18cf337a9
  @spec:demonstrates:01a1144e-56d6-7b81-a611-25b8ef853abb
  @spec:demonstrates:01a19a17-1e66-7995-8300-15f49c6c2f81
  Scenario: The command is refused for a member without the capture key and captures nothing
    Given a running uiux dev server for a Workspace with one View
    Given a member whose keys do not include evidence.capture, whose Token is in the UIUX_TOKEN environment variable
    When the operator runs `uiux evidence capture --view <id> --json`
    Then the command exits with status 1, prints nothing on standard output and names evidence.capture on standard error
    Then the artifact store holds no new Evidence
