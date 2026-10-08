Feature: Version history
  # Source: Discussion #122 (Part 11) d10 rule 4, R16 https://github.com/DevilTea/uiux/discussions/122; "What `.spec/` records after acceptance" key Scenarios https://github.com/DevilTea/uiux/discussions/122; owner acceptance https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a5e-1645-7f02-ae9e-05dd242e4a82 in its owner.
  # Note: No test exists yet; tracked in issue #132.
  @spec:id:01a11a5e-9106-73c2-b51b-107557aa88e8
  @spec:demonstrates:01a11a5e-1428-70eb-9d75-b54ba25015cb
  @spec:demonstrates:01a11a5e-14ce-7894-9c46-a8ad4b45e6d6
  @spec:demonstrates:01a11a5e-1645-7f02-ae9e-05dd242e4a82
  Scenario: A View restore keeps the current Decisions
    Given a View whose IR changed and which gained a decided Decision after an earlier version
    When an Editor restores the View to that version with its current revision
    Then the View's IR, Variants and non-Decision Spec sections equal those of that version
    Then the View keeps its current Decisions
    Then the restore is recorded as a new version that names the version it restored from
