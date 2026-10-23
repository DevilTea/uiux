Feature: A declaration naming a retired runtime generation is never acknowledged
  # Source: issue #102 (https://github.com/DevilTea/uiux/issues/102). Decisions behind the demonstrated Clause: #1 c124 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18643189; #1 c139 d2 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18651066.
  # Test: code@59b03b5 `tests/preview-generation-browser.test.ts#L59` "mints no generation in the Preview URL, and a reloaded document gets a new one, never reviving the old", whose last part sends a declaration of the retired generation. https://github.com/DevilTea/uiux/blob/59b03b5b16500c32a8b193965cca97ac10139395/tests/preview-generation-browser.test.ts#L59
  # Test: code@59b03b5 `tests/preview-protocol-bridge.test.ts#L319` "never revives a retired generation, even when its declaration arrives again". https://github.com/DevilTea/uiux/blob/59b03b5b16500c32a8b193965cca97ac10139395/tests/preview-protocol-bridge.test.ts#L319
  # Status: built as of 59b03b5.
  @spec:id:01a16504-b29c-77e5-8121-f3f999183efe
  @spec:demonstrates:01a1161c-4154-7de9-9dc5-622d21438a47
  Scenario: A declaration naming a retired runtime generation is never acknowledged
    Given the Preview document reloaded, so the Workbench retired its old generation and acknowledged the new one
    When a declaration naming the retired generation reaches the Workbench
    Then the Workbench does not acknowledge it
    Then the new generation stays current and live
