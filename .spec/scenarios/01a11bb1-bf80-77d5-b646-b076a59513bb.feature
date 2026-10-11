Feature: Workspace migration
  # Source: Discussion #139 (Part 14, Product Kit), decision 15, A; R18; owner pre-answer P24; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Test: code@77d9d59 `tests/workspace-relocation.test.ts#L191` "moves the data directories into .uiux/, keeps the manifest, artifact and kit paths, and leaves everything else alone". https://github.com/DevilTea/uiux/blob/77d9d592cef041c7587b2586df2872532bf074a7/tests/workspace-relocation.test.ts#L191
  # Test: code@77d9d59 `tests/workspace-relocation.test.ts#L515` "migrate, then access copy --from the old root, carries the roster and the history without --replace, and the Token works". https://github.com/DevilTea/uiux/blob/77d9d592cef041c7587b2586df2872532bf074a7/tests/workspace-relocation.test.ts#L515
  # Test: code@3b20412 `tests/workspace-relocation.test.ts#L206` "moves the data directories into .uiux/, keeps the manifest, artifact and kit paths, and leaves everything else alone". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/workspace-relocation.test.ts#L206
  # Test: code@3b20412 `tests/workspace-relocation.test.ts#L693` "migrate, then access copy --from the old root, carries the roster and the history without --replace, and the Token works". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/workspace-relocation.test.ts#L693
  # Status: built as of 3b20412.
  # Note: Discussion #140 (Part 15) adds `uiux.v5-to-v6`, so the converted Workspace ends at the current `schemaVersion` (issue #142).
  @spec:id:01a11bb1-bf7f-7c8e-bec7-1511c5f7d36f
  @spec:demonstrates:01a1144e-56bd-7988-8d2a-87b23954ca49
  @spec:demonstrates:01a11bb1-8f5f-77ea-817b-46679c5a6475
  @spec:demonstrates:01a11bb1-95f2-7c7c-bb53-a86069fd88ca
  Scenario: An old-layout Workspace converts in place and keeps its Tokens after the roster is copied
    Given an old-layout Workspace whose roster holds a member Token
    When an operator runs `uiux migrate` on it
    When the operator runs `uiux access copy` from the old Workspace root to the converted Workspace
    Then the old `.uiux/` directory is the Workspace root at the current `schemaVersion` and holds the Views
    Then the member Token authenticates against the converted Workspace
