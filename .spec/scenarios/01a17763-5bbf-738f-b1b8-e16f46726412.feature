Feature: An assertion that does not hold is recorded as fail
  # Source: Discussion #241 owner rulings 2026-10-26 (#89 replayable interaction Evidence) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19191424, ruling 1: assertions `{ expect, result }`.
  # Test: code@f56a91c `tests/interaction-evidence-browser.test.ts#L123` "records result fail, with the capture, when the actions do not cause the asserted Event". https://github.com/DevilTea/uiux/blob/f56a91c/tests/interaction-evidence-browser.test.ts#L123
  # Test: code@f56a91c `tests/interaction-evidence.test.ts#L146` "stores a record that references the capture, with the result the replay decided for each assertion". https://github.com/DevilTea/uiux/blob/f56a91c/tests/interaction-evidence.test.ts#L146
  # Status: built as of f56a91c.
  @spec:id:01a17763-5bbf-7716-998e-53ed9ce4f8be
  @spec:demonstrates:01a115cd-c507-738d-abd7-7a4194761319
  @spec:demonstrates:01a17762-b293-7157-aa2f-39a9c2ffbab5
  @spec:demonstrates:01a17762-b631-7681-965d-80e97eb92809
  Scenario: An assertion that does not hold is recorded as fail
    Given a View with a Button that declares the Event click
    When an Agent captures interaction Evidence that hovers the Button and asserts the Event click
    Then the record is stored with the assertion marked as fail
    Then the record still references the formal capture of the View
