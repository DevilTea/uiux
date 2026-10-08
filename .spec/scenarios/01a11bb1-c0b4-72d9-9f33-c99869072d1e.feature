Feature: Workspace layout and identity
  # Source: Discussion #139 (Part 14, Product Kit), decision 3, A; R3; owner pre-answer P21; Key Scenarios https://github.com/DevilTea/uiux/discussions/139; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18816364.
  # Status: not built as of 2f7e092; see the Implementation gaps entry of 01a11bb1-9585-7239-b371-0ac4032f2d5d in its owner.
  # Note: No test exists yet; tracked in issue #141.
  @spec:id:01a11bb1-c0b4-7b43-bd4a-b3cdc887a72c
  @spec:demonstrates:01a11bb1-8dcc-7d24-99de-52ca7778fd50
  @spec:demonstrates:01a11bb1-9585-7239-b371-0ac4032f2d5d
  Scenario: Authoring never writes inside the kit project
    Given a Workspace whose kit project holds component sources and build output
    When an Editor creates a View, updates the Workspace settings and changes the Product Kit file
    Then every file under `kit/` is unchanged
