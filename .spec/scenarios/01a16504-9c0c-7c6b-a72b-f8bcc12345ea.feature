Feature: A reloaded Preview document starts a new runtime generation and reacquires geometry
  # Source: issue #102 (https://github.com/DevilTea/uiux/issues/102). Decisions behind the demonstrated Clauses: #1 c123 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18643139; #1 c147 d2 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651771; #1 c148 d1 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651825.
  # Test: code@59b03b5 `tests/preview-generation-browser.test.ts#L59` "mints no generation in the Preview URL, and a reloaded document gets a new one, never reviving the old". https://github.com/DevilTea/uiux/blob/59b03b5b16500c32a8b193965cca97ac10139395/tests/preview-generation-browser.test.ts#L59
  # Test: code@59b03b5 `tests/preview-protocol-bridge.test.ts#L303` "treats a reloaded document as a new generation and retires the old one". https://github.com/DevilTea/uiux/blob/59b03b5b16500c32a8b193965cca97ac10139395/tests/preview-protocol-bridge.test.ts#L303
  # Test: code@59b03b5 `tests/preview-protocol-bridge.test.ts#L286` "admits the generation the first declaration names, without any allocation by the Workbench". https://github.com/DevilTea/uiux/blob/59b03b5b16500c32a8b193965cca97ac10139395/tests/preview-protocol-bridge.test.ts#L286
  # Status: built as of 59b03b5.
  @spec:id:01a16504-9c0c-77ae-b8ca-13808478f085
  @spec:demonstrates:01a1161c-4119-712d-8785-7d8155c0ceee
  @spec:demonstrates:01a1161c-4339-7614-ba65-6f21e37cd1a0
  Scenario: A reloaded Preview document starts a new runtime generation and reacquires geometry
    Given a View is open in the Workbench with a Widget selected and its Preview live
    When the Preview document reloads
    Then the reloaded document declares a new runtime generation ID that it minted itself, with no generation in the Preview URL
    Then the Workbench acknowledges the new generation and acquires the selected Widget geometry again under it
    Then the reloaded document receives nothing of the old generation
