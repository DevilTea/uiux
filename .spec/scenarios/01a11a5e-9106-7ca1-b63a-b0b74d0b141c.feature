Feature: Version history
  # Source: Discussion #122 (Part 11) d10 rule 4, R16 https://github.com/DevilTea/uiux/discussions/122; "What `.spec/` records after acceptance" key Scenarios https://github.com/DevilTea/uiux/discussions/122; owner acceptance https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18807263.
  # Status: built as of 6ee4a5c.
  # Test: code@6ee4a5c `tests/history-restore.test.ts#L186` "replaces its IR, Variants, name and non-Decision Spec, keeps its current Decisions, and records a version of its own naming the source". https://github.com/DevilTea/uiux/blob/6ee4a5cd0c7dcaaad91db13589e03ecd0691de36/tests/history-restore.test.ts#L186
  # Test: code@d23cdb6 `tests/history-restore-browser.test.ts#L135` "restores a View after confirmation, keeps its Decisions, and shows the restore as its own version naming its source". https://github.com/DevilTea/uiux/blob/d23cdb614bc8d11bbdbce9b4683ed1f458d86cf4/tests/history-restore-browser.test.ts#L135
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
