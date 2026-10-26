Feature: A Flow trace records a trigger whose Event the Widget does not emit as not valid
  # Source: Discussion #241 owner rulings 2026-10-26 (#88 Flow trigger replay) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851, item 4.
  # Test: code@65c9da2 `tests/flow-evidence-browser.test.ts#L158` "records a trigger whose Event the Widget does not emit as valid false, not as a held transition". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence-browser.test.ts#L158
  # Test: code@65c9da2 `tests/flow-evidence.test.ts#L333` "replays the given perform on the entered Variant, and records an Event that did not occur exactly once as invalid". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence.test.ts#L333
  # Status: built as of 65c9da2.
  @spec:id:01a17928-8e52-77b4-beeb-a38402bcb901
  @spec:demonstrates:01a11544-66d9-7fcd-8400-93516ddf2857
  @spec:demonstrates:01a172cc-d6f0-714d-b2fb-bd66e13c73a5
  @spec:demonstrates:01a172cc-daa6-7a0e-960e-fa996e0a58c5
  Scenario: A Flow trace records a trigger whose Event the Widget does not emit as not valid
    Given a valid UX Flow whose first step has a Button that does not declare the Event press
    When an Agent captures formal Flow Evidence for the Flow without a recipe
    Then the replay dispatches a real click on the rendered Button
    Then the stored step is not valid because the Event press did not occur
    Then the trace is recorded and the run is not refused
