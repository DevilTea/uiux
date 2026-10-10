Feature: Access and roster
  # Source: Discussion #140 (Part 15, permission keys and role presets), What `humanOnly` means; R4; owner answer Q5; Key Scenarios https://github.com/DevilTea/uiux/discussions/140; accepted as written 2026-10-08 https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18816365.
  # Status: built as of 98672a4 for this path; the open gap of 01a11485-fa66-7cde-a10f-b8b796d01469 (`update_access_presets`) is not exercised here.
  # Test: code@98672a4 `tests/access-http.test.ts#L355` "refuses a human Owner's bearer Token a force-release, naming locks.force-release, and keeps the lease (Scenario 01a11c09-d861)". https://github.com/DevilTea/uiux/blob/98672a48d3d0babd56b8d471322cb3eea13f0d7f/tests/access-http.test.ts#L355
  @spec:id:01a11c09-d861-7c3e-9b90-b38b63ae6187
  @spec:demonstrates:01a11485-fa66-7cde-a10f-b8b796d01469
  @spec:demonstrates:01a11c09-bec8-7dee-971a-4c10eaf83eef
  Scenario: A human's bearer Token cannot force-release a lease
    Given an Agent holds a lease on a View
    Given a human member holding `locks.force-release`
    When the member's Token is sent as a bearer credential to force-release that lease
    Then the request is refused with `auth.scope_denied` whose `requiredKeys` is `locks.force-release`
    Then the lease is still held
