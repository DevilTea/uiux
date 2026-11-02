Feature: Command-line interface
  # Source: [#379 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, option A with these defaults](https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19341867); issue #466 https://github.com/DevilTea/uiux/issues/466.
  # Test: code@d0c23e4 `tests/cli-evidence-server.test.ts#L146` "captures formal Evidence that is fresh for the View, finding the server through its hold". https://github.com/DevilTea/uiux/blob/d0c23e4e281d0c080e2808438f933372724e99bf/tests/cli-evidence-server.test.ts#L146
  # Test: code@d0c23e4 `tests/cli-evidence.test.ts#L217` "captures the named Variant next to the base context only when it is named". https://github.com/DevilTea/uiux/blob/d0c23e4e281d0c080e2808438f933372724e99bf/tests/cli-evidence.test.ts#L217
  # Status: built as of d0c23e4.
  @spec:id:01a19a18-c3b2-7c94-adaf-1d6665f3baa5
  @spec:demonstrates:01a115cd-c395-72b0-be67-4a77c4d2ade4
  @spec:demonstrates:01a19a17-1381-74db-bda9-efd8176865c6
  @spec:demonstrates:01a19a17-2a19-7c11-98cf-b3f023c450f8
  Scenario: The command captures a named Variant beside the base context as a member with the capture key
    Given a running uiux dev server for a Workspace with one View that has a Variant, two viewport presets and two themes
    Given a member who holds evidence.capture, whose Token is in the UIUX_TOKEN environment variable
    When the operator runs `uiux evidence capture --view <id> --variant <name> --viewport <id> --theme <id> --json`
    Then the command exits with status 0 and prints a result whose status is ok, with one captured context for the base context and one for the Variant
    Then the Workbench lists formal Evidence for each context that is fresh for the View's current render input
