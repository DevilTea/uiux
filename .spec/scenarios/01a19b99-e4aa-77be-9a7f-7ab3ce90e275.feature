Feature: A member without workspace.read cannot read a thumbnail
  # Source: [#480 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, decisions 1-4 and the design](https://github.com/DevilTea/uiux/discussions/480); issue #481 https://github.com/DevilTea/uiux/issues/481.
  # Test: code@a2b2a01 `tests/thumbnail-http.test.ts#L114` "needs a credential, and refuses a member without workspace.read on all three operations with no image". https://github.com/DevilTea/uiux/blob/a2b2a01ae4ccac74288f682dd8941306681f6def/tests/thumbnail-http.test.ts#L114
  # Status: built as of a2b2a01.
  @spec:id:01a19b99-e4aa-725b-8a77-4a1f16102119
  @spec:demonstrates:01a19bb9-8f1f-7482-b6fd-f131a284178e
  Scenario: A member without workspace.read cannot read a thumbnail
    Given a View with a fresh thumbnail and a member who holds no permission key
    When the member requests the View's thumbnail
    Then the server refuses the request and sends no image
