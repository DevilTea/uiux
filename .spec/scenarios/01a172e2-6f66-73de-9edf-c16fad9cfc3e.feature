Feature: Reference integrity and destructive changes
  # Source: #241 owner rulings 2026-10-25 (#75) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19177134.
  # Test: code@257b3c5 `tests/reference-impact-browser.test.ts#L70` "lists the impact, deletes nothing on Cancel, and deletes only after "Delete anyway", leaving the thread untouched". https://github.com/DevilTea/uiux/blob/257b3c528935a5d6e2d09f01cc938db160381b8a/tests/reference-impact-browser.test.ts#L70
  # Status: built as of 257b3c5.
  @spec:id:01a172e2-6f65-7492-89d6-c6c2349244a2
  @spec:demonstrates:01a172ce-280b-7cec-9ca5-ec189b313ebe
  @spec:demonstrates:01a172ce-31eb-7b81-afd6-ddd6855cc30e
  Scenario: The Workbench confirms the impact before deleting a View
    Given a View with a Review thread anchored in it, open on its page
    When an Editor chooses Delete, confirms, and then chooses "Delete anyway"
    Then the Workbench lists the impact the server returned before it deletes
    Then the View is deleted and the thread is unchanged
