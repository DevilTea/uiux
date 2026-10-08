Feature: Adapter selection and resolution
  # Source: Discussion #139 (Part 14, Product Kit), decision 3, A; R4; owner pre-answer P21; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 2f7e092; see the Implementation gaps entry of 01a115cd-d109-76d3-9622-85d0080c60b6 in its owner.
  # Note: No test exists yet; tracked in issue #141. PR #138 (https://github.com/DevilTea/uiux/pull/138) builds this for the current layout.
  @spec:id:01a11bb1-c04e-7be3-9936-e2ff1272ef38
  @spec:demonstrates:01a115cd-d109-76d3-9622-85d0080c60b6
  Scenario: An Adapter specifier that resolves into a data directory is invalid
    Given a JavaScript module stored in the Workspace's `views/` directory
    When an Adapter entry selects that module through its specifier
    Then the Adapter is invalid with a resolution diagnostic
