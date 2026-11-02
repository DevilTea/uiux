Feature: Preview cross-iframe protocol
  # Source: [#241 follow-up owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, M2, M3 and m2](https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19343798); issue #52 https://github.com/DevilTea/uiux/issues/52.
  # Test: code@ba8c819 `tests/base-state-requests.test.ts#L395` "a pending-id response that does not answer exactly its keys is rejected whole". https://github.com/DevilTea/uiux/blob/ba8c819347d5d521b6594aefd896cc6f1c47f9db/tests/base-state-requests.test.ts#L395
  # Test: code@ba8c819 `tests/base-state-requests.test.ts#L387` "a pending-id response that echoes another widgetId is rejected whole: its keys read Unavailable". https://github.com/DevilTea/uiux/blob/ba8c819347d5d521b6594aefd896cc6f1c47f9db/tests/base-state-requests.test.ts#L387
  # Status: Partly built as of ba8c819: the rejection is built; the View revision the Workbench compares is an approximation until the Preview reports the revision it read (issue #484).
  @spec:id:01a19ab9-dd01-7cd6-bb11-ff943a19fc56
  @spec:demonstrates:01a19a9d-a01a-72bd-9ea0-cad4e90ae7fc
  @spec:demonstrates:01a19ab9-cc7c-749c-98fc-ebf18dd27743
  @spec:demonstrates:01a19ab9-d028-7bb9-a370-4736992852f5
  Scenario: A response that does not echo the pending request's keys is rejected whole
    Given a Workbench Preview generation that declared `inspection.base-state` and a pending request for the keys `disabled` and `label` of a Button
    When the runtime answers with the pending `requestId` and a `values` object holding only `disabled`
    Then the Workbench rejects the response whole and the Preview session and generation continue
    Then the Base cells of `disabled` and `label` read Unavailable
