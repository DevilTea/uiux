Feature: A partial update_locale changes only the named keys
  # Source: Discussion #434, Option A and its test plan https://github.com/DevilTea/uiux/discussions/434; owner acceptance https://github.com/DevilTea/uiux/discussions/434#discussioncomment-19313132.
  # Status: not built as of 7f0971b2: `update_locale` takes only `messages`; the Rule 01a191cf-959a-7e4b-9d2e-04f6abe78989 and the Clause 01a191cf-5734-73c7-9bf2-b437c39ae072 are marked Not built in their Implementation gaps; tracked in issue #436 (https://github.com/DevilTea/uiux/issues/436).
  @spec:id:01a191cf-e873-793b-8c2c-90a3a2f314d4
  @spec:demonstrates:01a191cf-5734-73c7-9bf2-b437c39ae072
  @spec:demonstrates:01a191cf-959a-7e4b-9d2e-04f6abe78989
  Scenario: A partial update_locale changes only the named keys
    Given a Workspace whose Locale `en-US` holds the keys `a`, `b` and `c`
    When an Agent calls `update_locale` for `en-US` with the current `expectedRevision`, `set` giving `a` a new value and `remove` listing `c`
    Then the result is `updated`
    Then `en-US` holds `a` with the new value and `b` unchanged, and no longer holds `c`
