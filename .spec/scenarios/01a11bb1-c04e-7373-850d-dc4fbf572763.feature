Feature: Adapter selection and resolution
  # Source: Discussion #139 (Part 14, Product Kit), decision 3, A; R4; owner pre-answer P21; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: built as of 3b20412.
  # Test: code@9691b8c `tests/adapter-resolution.test.ts#L62` "refuses relative adapters that resolve inside canonical Workspace data directories while allowing adapters/". https://github.com/DevilTea/uiux/blob/9691b8caae0a8b5315bb33c45469f74d517a4bd5/tests/adapter-resolution.test.ts#L62
  # Test: code@82e151f `tests/adapter-resolution.test.ts#L426` "refuses every path of a selected v5 root but kit/, also through a symlink out of kit/". https://github.com/DevilTea/uiux/blob/82e151f10a80d56256f43e9267cedfeebefec23d/tests/adapter-resolution.test.ts#L426
  # Test: code@0958696 `tests/preview-adapter-materialization.test.ts#L667` "reports an Adapter outside kit/ or an undeclared package as a resolution diagnostic of the Product Kit list". https://github.com/DevilTea/uiux/blob/09586962ae0b39be67fc7c8b32c8136133110990/tests/preview-adapter-materialization.test.ts#L667
  # Test: code@0958696 `tests/adapter-resolution.test.ts#L705` "refuses a declared package whose main, exports target or link leads into the Workspace root outside kit/". https://github.com/DevilTea/uiux/blob/09586962ae0b39be67fc7c8b32c8136133110990/tests/adapter-resolution.test.ts#L705
  # Test: code@3b20412 `tests/adapter-resolution.test.ts#L482` "refuses every path of a selected v5 root but kit/, also through a symlink out of kit/". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/adapter-resolution.test.ts#L482
  # Test: code@3b20412 `tests/preview-adapter-materialization.test.ts#L669` "reports an Adapter outside kit/ or an undeclared package as a resolution diagnostic of the Product Kit list". https://github.com/DevilTea/uiux/blob/3b20412aff65b677618b90a4a841ad8dfccf4218/tests/preview-adapter-materialization.test.ts#L669
  @spec:id:01a11bb1-c04e-7be3-9936-e2ff1272ef38
  @spec:demonstrates:01a115cd-d109-76d3-9622-85d0080c60b6
  Scenario: An Adapter specifier that resolves into a data directory is invalid
    Given a JavaScript module stored in the Workspace's `views/` directory
    When an Adapter entry selects that module through its specifier
    Then the Adapter is invalid with a resolution diagnostic
