Feature: Capturing formal Flow Evidence records a trace that references a capture of each entered View
  # Source: Discussion #241 owner rulings 2026-10-25 (#88 Flows on the server) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19177134, items 4-6.
  # Test: code@65c9da2 `tests/flow-evidence-browser.test.ts#L103` "derives a click for a click trigger, captures each entered View and Variant, replays it as a real click, and stores a trace that references the captures". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence-browser.test.ts#L103
  # Test: code@65c9da2 `tests/flow-evidence.test.ts#L50` "derives a recipe that enters every step and takes every transition, in a fixed order". https://github.com/DevilTea/uiux/blob/65c9da2/tests/flow-evidence.test.ts#L50
  # Status: built as of 65c9da2.
  @spec:id:01a172d3-f0ff-7b92-9067-2647bde918da
  @spec:demonstrates:01a11544-6628-73b9-b10a-9643d264bea1
  @spec:demonstrates:01a172cc-d382-7cd3-b140-6320d2065edc
  @spec:demonstrates:01a172cc-d6f0-714d-b2fb-bd66e13c73a5
  @spec:demonstrates:01a172cc-daa6-7a0e-960e-fa996e0a58c5
  @spec:demonstrates:01a172cc-e195-711b-bfa9-5de6c1c8ff87
  Scenario: Capturing formal Flow Evidence records a trace that references a capture of each entered View
    Given a valid UX Flow of two steps and a render context of the Workspace
    When an Agent captures formal Flow Evidence for the Flow in that render context
    Then a formal capture is stored for each View and Variant the recipe enters
    Then a flow_trace record is stored whose steps name each step, trigger, resulting step and capture
    Then capturing again with the stored recipe records a trace of the same steps
