Feature: Access presets
  # Source: Discussion #140 (Part 15, permission keys and role presets), decision 5, A: Label rule 2; R15; owner answer Q7; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: not built as of 0c26ead; see the Implementation gaps entry of 01a11c09-c8db-7236-87a1-5720487c486a in its owner.
  # Note: No test exists yet; tracked in issue #142.
  @spec:id:01a11c09-d61f-7c85-a546-ca2ac18603c1
  @spec:demonstrates:01a11c09-c8db-7236-87a1-5720487c486a
  Scenario: An Agent holding the Editor keys it can hold is labeled Editor
    Given the built-in presets
    Given an Agent member holding every key of the Editor preset except `reviews.resolve`
    When a manager lists the members
    Then the Agent is labeled Editor
