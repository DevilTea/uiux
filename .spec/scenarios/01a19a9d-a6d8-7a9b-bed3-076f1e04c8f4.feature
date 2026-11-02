Feature: View Variants
  # Source: [#241 proposal and owner ruling 2026-11-02 (question tool, recorded by Claude on the owner's behalf): accepted, with these defaults](https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19343472); issue #52 https://github.com/DevilTea/uiux/issues/52.
  # Test: code@ba8c819 `tests/base-state-requests.test.ts#L204` "ends the request with its keys Unavailable, and a later response is stale". https://github.com/DevilTea/uiux/blob/ba8c819347d5d521b6594aefd896cc6f1c47f9db/tests/base-state-requests.test.ts#L204
  # Test: code@ba8c819 `tests/inspector-base-state-browser.test.ts#L154` "shows pending while the request is outstanding, then Unavailable when the Preview never answers". https://github.com/DevilTea/uiux/blob/ba8c819347d5d521b6594aefd896cc6f1c47f9db/tests/inspector-base-state-browser.test.ts#L154
  # Status: built as of ba8c819.
  @spec:id:01a19a9d-a6d8-723a-9bd0-21f134ace604
  @spec:demonstrates:01a19a9b-3c4d-74cb-9695-ce20087e2188
  @spec:demonstrates:01a19a9d-a01a-72bd-9ea0-cad4e90ae7fc
  Scenario: The Base cell reads Unavailable when the runtime does not answer in time
    Given a Workbench Preview generation that declared `inspection.base-state` whose runtime never answers an `inspection.base-state.request`
    When the user selects a Widget that the open Variant overrides
    When 5000 ms pass without a response
    Then the Base cell of each overridden State member reads Unavailable
    Then a response of that request arriving later changes no Base cell
