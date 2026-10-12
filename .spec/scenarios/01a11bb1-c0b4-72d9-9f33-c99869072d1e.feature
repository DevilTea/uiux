Feature: Workspace layout and identity
  # Source: Discussion #139 (Part 14, Product Kit), decision 3, A; R3; owner pre-answer P21; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: built as of 3b20412 for what this Scenario shows; the Access presets file of `schemaVersion` 6, which 01a11bb1-8dcc-7d24-99de-52ca7778fd50 also names, is built as of 39e99da.
  # Test: code@82e151f `tests/workspace-layout-v5.test.ts#L290` "never creates, changes or deletes anything in kit/ (Rule 01a11bb1-9585)". https://github.com/DevilTea/uiux/blob/82e151f10a80d56256f43e9267cedfeebefec23d/tests/workspace-layout-v5.test.ts#L290
  # Test: code@3b20412 `tests/product-kit-authoring.test.ts#L920` "leaves every file under kit/ unchanged when an Editor creates a View, updates the Workspace settings and changes the Product Kit file". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/product-kit-authoring.test.ts#L920
  @spec:id:01a11bb1-c0b4-7b43-bd4a-b3cdc887a72c
  @spec:demonstrates:01a11bb1-8dcc-7d24-99de-52ca7778fd50
  @spec:demonstrates:01a11bb1-9585-7239-b371-0ac4032f2d5d
  Scenario: Authoring never writes inside the kit project
    Given a Workspace whose kit project holds component sources and build output
    When an Editor creates a View, updates the Workspace settings and changes the Product Kit file
    Then every file under `kit/` is unchanged
