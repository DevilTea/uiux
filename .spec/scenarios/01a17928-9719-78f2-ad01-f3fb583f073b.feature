Feature: A derived Flow recipe performs a click for a press or click trigger
  # Source: Discussion #241 owner rulings 2026-10-26 (#88 Flow trigger replay) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851, item 4; refined by https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19200269 (a derived click trigger also performs a click).
  # Test: code@65c9da2 `tests/flow-evidence-browser.test.ts#L103` "derives a click for a click trigger, captures each entered View and Variant, replays it as a real click, and stores a trace that references the captures". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence-browser.test.ts#L103
  # Test: code@65c9da2 `tests/flow-evidence.test.ts#L315` "performs a derived press trigger as a click and asserts its Event exactly once, then records the replay as valid". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence.test.ts#L315
  # Test: code@65c9da2 `tests/flow-evidence.test.ts#L50` "derives a recipe that enters every step and takes every transition, in a fixed order". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence.test.ts#L50
  # Status: built as of 65c9da2.
  @spec:id:01a17928-9719-70b3-bab1-5739226cc6cd
  @spec:demonstrates:01a11544-66d9-7fcd-8400-93516ddf2857
  @spec:demonstrates:01a172cc-d6f0-714d-b2fb-bd66e13c73a5
  Scenario: A derived Flow recipe performs a click for a press or click trigger
    Given a valid UX Flow whose first step has a Button that declares the Event click
    When an Agent captures formal Flow Evidence for the Flow without a recipe
    Then the stored recipe gives the trigger the perform click
    Then the replay dispatches a real click and the stored step is valid
