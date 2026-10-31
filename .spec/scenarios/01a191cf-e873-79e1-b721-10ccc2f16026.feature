Feature: A partial update_locale changes only the named keys
  # Source: Discussion #434, Option A and its test plan https://github.com/DevilTea/uiux/discussions/434; owner acceptance https://github.com/DevilTea/uiux/discussions/434#discussioncomment-19313132.
  # Test: code@08d06a38 `tests/transport-authoring.test.ts#L776` "merges set and remove and keeps every other key". https://github.com/DevilTea/uiux/blob/08d06a38ec6bb41c3fbb08ddcc7e5d2a15741c57/tests/transport-authoring.test.ts#L776
  # Test: code@08d06a38 `tests/transport-authoring.test.ts#L804` "works through the strict MCP schema and rejects unknown fields". https://github.com/DevilTea/uiux/blob/08d06a38ec6bb41c3fbb08ddcc7e5d2a15741c57/tests/transport-authoring.test.ts#L804
  # Test: code@08d06a38 `tests/transport-authoring.test.ts#L824` "mirrors set and remove on PUT /api/locales/:locale". https://github.com/DevilTea/uiux/blob/08d06a38ec6bb41c3fbb08ddcc7e5d2a15741c57/tests/transport-authoring.test.ts#L824
  # Status: built as of 08d06a38.
  @spec:id:01a191cf-e873-793b-8c2c-90a3a2f314d4
  @spec:demonstrates:01a191cf-5734-73c7-9bf2-b437c39ae072
  @spec:demonstrates:01a191cf-959a-7e4b-9d2e-04f6abe78989
  Scenario: A partial update_locale changes only the named keys
    Given a Workspace whose Locale `en-US` holds the keys `a`, `b` and `c`
    When an Agent calls `update_locale` for `en-US` with the current `expectedRevision`, `set` giving `a` a new value and `remove` listing `c`
    Then the result is `updated`
    Then `en-US` holds `a` with the new value and `b` unchanged, and no longer holds `c`
