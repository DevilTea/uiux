Feature: Access and roster
  # Source: Discussion #140 (Part 15, permission keys and role presets), decision 11, A; R23; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: not built as of 0c26ead; see the Implementation gaps entry of 01a11c09-b623-7824-8745-9c10510d0d53 in its owner.
  # Note: No test exists yet; tracked in issue #142.
  @spec:id:01a11c09-d7ef-7fde-a505-929046492a07
  @spec:demonstrates:01a11bb1-b427-777e-8175-fa24d61d434b
  @spec:demonstrates:01a11c09-a195-768b-ba6e-a64eb7f05eca
  @spec:demonstrates:01a11c09-b623-7824-8745-9c10510d0d53
  @spec:demonstrates:01a11c09-b698-7ee3-861b-f02eaba61269
  Scenario: A version 1 roster upgrades on first open and keeps a backup
    Given a version 1 roster with a human Owner and an Agent Editor
    When `uiux dev` opens it
    Then the roster is at version 2 and the human member holds every catalog key
    Then the Agent holds the keys of the Editor preset except `reviews.resolve`
    Then `access.v1.json` beside the roster holds the version 1 roster
