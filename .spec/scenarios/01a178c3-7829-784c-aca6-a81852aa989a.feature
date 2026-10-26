Feature: A Flow trace replays a trigger as a real click and records whether its Widget Event occurred
  # Source: Discussion #241 owner rulings 2026-10-26 (#88 Flow trigger replay) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851, item 4.
  # Test: code@65c9da2 `tests/flow-evidence-browser.test.ts#L103` "derives a click for a click trigger, captures each entered View and Variant, replays it as a real click, and stores a trace that references the captures". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence-browser.test.ts#L103
  # Test: code@65c9da2 `tests/flow-evidence.test.ts#L333` "replays the given perform on the entered Variant, and records an Event that did not occur exactly once as invalid". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence.test.ts#L333
  # Status: built as of 65c9da2.
  @spec:id:01a178c3-7828-7203-889a-1c6cd144b861
  @spec:demonstrates:01a11544-66d9-7fcd-8400-93516ddf2857
  @spec:demonstrates:01a172cc-d6f0-714d-b2fb-bd66e13c73a5
  @spec:demonstrates:01a172cc-daa6-7a0e-960e-fa996e0a58c5
  Scenario: A Flow trace replays a trigger as a real click and records whether its Widget Event occurred
    Given a valid UX Flow whose first step has a Button that declares the Event click
    When an Agent captures formal Flow Evidence with a recipe whose trigger performs a click on the Button
    Then the replay dispatches a real click on the rendered Button in the Preview of the entered View
    Then the stored step is valid because the Event click occurred exactly once
