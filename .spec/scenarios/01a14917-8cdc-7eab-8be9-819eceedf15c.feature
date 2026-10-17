Feature: Version history
  # Source: Discussion #231 (Part 17, one current format) https://github.com/DevilTea/uiux/discussions/231; owner acceptance 2026-10-17 https://github.com/DevilTea/uiux/discussions/231#discussioncomment-18992111: Change 5.1, the `.spec/` units New table.
  # Status: built as of 483b6ab.
  # Test: code@483b6ab `tests/history-diff-service.test.ts#L190` "lists a version recorded under another schemaVersion, older or newer, but refuses to compare it with workspace.schema_unsupported (Rule 01a11a5e-081c, Clause 01a11a5e-2434-7342-a3c1-6d63aa74334c)". https://github.com/DevilTea/uiux/blob/483b6ab6797c1a4615735744ddefc3722e24d578/tests/history-diff-service.test.ts#L190
  # Test: code@483b6ab `tests/history-preview.test.ts#L263` "refuses a version recorded under an older or newer schemaVersion with workspace.schema_unsupported (422)". https://github.com/DevilTea/uiux/blob/483b6ab6797c1a4615735744ddefc3722e24d578/tests/history-preview.test.ts#L263
  # Test: code@483b6ab `tests/history-restore.test.ts#L511` "refuses a version recorded under another schemaVersion, older or newer, and writes nothing (Rule 01a11a5e-081c, Clause 01a11a5e-2434)". https://github.com/DevilTea/uiux/blob/483b6ab6797c1a4615735744ddefc3722e24d578/tests/history-restore.test.ts#L511
  @spec:id:01a14917-8cdc-7b2c-9c74-2271842c9ba7
  @spec:demonstrates:01a11a5e-081c-7149-9345-836ce2267c0a
  @spec:demonstrates:01a11a5e-2434-7342-a3c1-6d63aa74334c
  Scenario: A version recorded under an older schemaVersion is listed but cannot be compared
    Given a Workspace with a host version recorded at `workspaceSchemaVersion` 5
    When a member lists the versions
    When the member compares that version with the current state
    Then the version appears in the list
    Then the comparison is refused with `workspace.schema_unsupported`
