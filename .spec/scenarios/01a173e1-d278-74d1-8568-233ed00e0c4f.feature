Feature: Reference integrity and destructive changes
  # Source: https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19180530.
  # Test: code@9910a73 `tests/reference-impact-ack.test.ts#L607` "restores a View created and deleted within one autosave window". https://github.com/DevilTea/uiux/blob/9910a73d2717b8efbe0d8793922707e5fc665bc6/tests/reference-impact-ack.test.ts#L607
  # Status: built as of 9910a73.
  @spec:id:01a173e1-d278-77e4-806b-2dd17b7c7e9d
  @spec:demonstrates:01a11a5e-00b9-7bf5-8005-9380a388afb8
  @spec:demonstrates:01a11a5e-16a2-7c0b-9495-3dae49e9dda3
  @spec:demonstrates:01a172ce-ebcc-7a79-8103-ff5339409948
  Scenario: A deleted resource can be restored to the state just before the delete
    Given a View that an Editor created and then edited within one autosave window
    When the Editor deletes the View
    Then the open autosave closes before the delete, so the delete is a version of its own
    Then restoring the View from the earlier version with an `expectedRevision` of `null` re-creates it as it was just before the delete
