Feature: A Flow trace replays a trigger as a real click and records whether its Widget Event occurred
  # Source: Discussion #241 owner rulings 2026-10-26 (#88 Flow trigger replay) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851, item 4.
  # Test: code@e9721c9 `tests/flow-evidence-browser.test.ts#L101` "captures each entered View and Variant, replays the trigger as a real click, and stores a trace that references the captures". https://github.com/DevilTea/uiux/blob/e9721c9/tests/flow-evidence-browser.test.ts#L101
  # Test: code@e9721c9 `tests/flow-evidence-browser.test.ts#L156` "records a trigger whose Event the Widget does not emit as valid false, not as a held transition". https://github.com/DevilTea/uiux/blob/e9721c9/tests/flow-evidence-browser.test.ts#L156
  # Test: code@e9721c9 `tests/flow-evidence.test.ts#L312` "replays the given perform on the entered Variant, and records an Event that did not occur exactly once as invalid". https://github.com/DevilTea/uiux/blob/e9721c9/tests/flow-evidence.test.ts#L312
  # Status: built as of e9721c9.
  @spec:id:01a178c3-7828-7203-889a-1c6cd144b861
  @spec:demonstrates:01a11544-66d9-7fcd-8400-93516ddf2857
  @spec:demonstrates:01a172cc-d6f0-714d-b2fb-bd66e13c73a5
  @spec:demonstrates:01a172cc-daa6-7a0e-960e-fa996e0a58c5
  Scenario: A Flow trace replays a trigger as a real click and records whether its Widget Event occurred
    Given a valid UX Flow whose first step has a Button that declares the Event click
    When an Agent captures formal Flow Evidence with a recipe whose trigger performs a click on the Button
    Then the replay dispatches a real click on the rendered Button in the Preview of the entered View
    Then the stored step is valid because the Event click occurred exactly once
    Then a trigger whose Event the Button does not declare is recorded as a step that is not valid
