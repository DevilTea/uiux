Feature: Access presets
  # Source: Discussion #140 (Part 15, permission keys and role presets), decision 10, A; owner answer Q2; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: not built as of 0c26ead; see the Implementation gaps entry of 01a11c09-ca2d-7b0e-b428-e2d66f5252dd in its owner.
  # Note: No test exists yet; tracked in issue #142.
  @spec:id:01a11c09-d6fe-7bc7-935f-842ae16b47ee
  @spec:demonstrates:01a11c09-c78f-773d-ad98-5c6def1b22e3
  @spec:demonstrates:01a11c09-c94c-77f1-b8e0-b9594584c193
  @spec:demonstrates:01a11c09-ca2d-7b0e-b428-e2d66f5252dd
  Scenario: Deleting every preset leaves every member Custom with unchanged keys
    Given members labeled by the built-in presets
    When a holder of `presets.manage` deletes every preset
    Then every member is labeled Custom
    Then every member keeps its keys
