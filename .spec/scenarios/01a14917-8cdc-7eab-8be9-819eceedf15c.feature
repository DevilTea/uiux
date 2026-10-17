Feature: Version history
  # Source: Discussion #231 (Part 17, one current format) https://github.com/DevilTea/uiux/discussions/231; owner acceptance 2026-10-17 https://github.com/DevilTea/uiux/discussions/231#discussioncomment-18992111: Change 5.1, the `.spec/` units New table.
  # Status: partly built as of 21c5130: the version is listed, but a version recorded at `workspaceSchemaVersion` 5 is still upgraded in memory and compared; see the Implementation gaps entries of 01a11a5e-081c-7149-9345-836ce2267c0a and 01a11a5e-2434-7342-a3c1-6d63aa74334c in their owners (issue #232).
  # Note: No test exists yet for the refusal.
  @spec:id:01a14917-8cdc-7b2c-9c74-2271842c9ba7
  @spec:demonstrates:01a11a5e-081c-7149-9345-836ce2267c0a
  @spec:demonstrates:01a11a5e-2434-7342-a3c1-6d63aa74334c
  Scenario: A version recorded under an older schemaVersion is listed but cannot be compared
    Given a Workspace with a host version recorded at `workspaceSchemaVersion` 5
    When a member lists the versions
    When the member compares that version with the current state
    Then the version appears in the list
    Then the comparison is refused with `workspace.schema_unsupported`
