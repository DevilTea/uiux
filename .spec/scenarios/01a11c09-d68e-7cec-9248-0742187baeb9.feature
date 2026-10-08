Feature: Access presets
  # Source: Discussion #140 (Part 15, permission keys and role presets), decision 10, A; R22; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: not built as of 0c26ead; see the Implementation gaps entry of 01a11c09-ca2d-7b0e-b428-e2d66f5252dd in its owner.
  # Note: No test exists yet; tracked in issue #142.
  @spec:id:01a11c09-d68e-7b6c-bc7c-0757ba4a5c33
  @spec:demonstrates:01a11c09-c86b-7526-a517-6220b027387a
  @spec:demonstrates:01a11c09-ca2d-7b0e-b428-e2d66f5252dd
  Scenario: Renaming a preset in a commit changes labels only
    Given a human member labeled Editor by the preset `editor`
    When a pulled commit renames that preset to Author
    Then the member is labeled Author
    Then the member's keys are unchanged
