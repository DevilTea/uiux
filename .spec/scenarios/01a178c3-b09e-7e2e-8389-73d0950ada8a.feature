Feature: A Flow trace without a browser action for a trigger is refused
  # Source: Discussion #241 owner rulings 2026-10-26 (#88 Flow trigger replay) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851, item 4.
  # Test: code@65c9da2 `tests/flow-evidence-browser.test.ts#L167` "refuses a derived recipe whose trigger Event is neither press nor click, before a browser runs, and records nothing". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence-browser.test.ts#L167
  # Test: code@65c9da2 `tests/flow-evidence.test.ts#L363` "refuses a derived recipe with a trigger that is neither press nor click before any capture or replay, and records nothing". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence.test.ts#L363
  # Test: code@65c9da2 `tests/flow-evidence.test.ts#L256` "accepts a recipe whose trigger carries perform through the MCP schema, leaving its judgement to the domain". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence.test.ts#L256
  # Status: built as of 65c9da2.
  @spec:id:01a178c3-b09e-7145-af2c-dfaedce5b946
  @spec:demonstrates:01a172cc-d6f0-714d-b2fb-bd66e13c73a5
  @spec:demonstrates:01a172cc-e195-711b-bfa9-5de6c1c8ff87
  Scenario: A Flow trace without a browser action for a trigger is refused
    Given a valid UX Flow whose trigger names the Event change
    When an Agent captures formal Flow Evidence for the Flow without a recipe
    Then the capture is refused with a diagnostic that names the trigger without a perform
    Then no browser runs and nothing is recorded
