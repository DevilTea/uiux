Feature: Preview canvas
  # Source: spec import batch 8 (Scenarios), priority P2. Decisions behind the demonstrated Rules and Clauses: #3 c6 item 2.1 https://github.com/DevilTea/uiux/discussions/3#discussioncomment-18760674.
  # Test: code@a021f9e `tests/workbench-browser.test.ts#L691` "draws the runtime hover candidate: Iris in Select, dashed Marker in Comment, none in Interact". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workbench-browser.test.ts#L691
  # Status: built as of a021f9e.
  @spec:id:01a118a1-d766-701e-aa68-2bacf0e9ff23
  @spec:demonstrates:01a11658-2066-7f38-9f08-0f5f053b9762
  @spec:demonstrates:01a11658-20a8-72f2-afa2-263d19d8aba3
  Scenario: Pointer input under the Interact tool never crosses the Preview boundary
    Given a View on the canvas with the Interact tool
    When the Reviewer moves the pointer over a Widget and clicks it
    Then the Workbench draws no hover outline and commits no target
