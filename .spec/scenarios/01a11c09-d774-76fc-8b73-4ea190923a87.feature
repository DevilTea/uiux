Feature: Access presets
  # Source: Discussion #140 (Part 15, permission keys and role presets), decision 5, A; R13; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: built as of 39e99da.
  # Test: code@39e99da `tests/access-presets.test.ts#L342` "refuses saving QA with the keys of Reviewer, naming both, and leaves the file unchanged (Scenario 01a11c09-d774)". https://github.com/DevilTea/uiux/blob/39e99da86eec36860acb97077deddd836cce9a33/tests/access-presets.test.ts#L342
  @spec:id:01a11c09-d774-7d5c-bc82-44fa95baaabb
  @spec:demonstrates:01a11c09-a57d-7d3d-a46f-1e9512200f74
  @spec:demonstrates:01a11c09-c7ff-72bb-8afe-2a7d1dc1024d
  Scenario: Making two presets equal is refused
    Given the presets Reviewer and QA with different key sets
    When a holder of `presets.manage` saves QA with the keys of Reviewer
    Then the save is refused with `access.preset_duplicate` naming both presets
    Then the presets file is unchanged
