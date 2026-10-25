Feature: A Handoff readiness assessment is blocked by a Flow reference diagnostic
  # Source: Discussion #241 owner rulings 2026-10-25 (#88 Flows on the server) https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19177134, items 4-6.
  # Test: code@33bca1f `tests/flow-evidence.test.ts#L185` "blocks the Handoff readiness of a Flow root with a reference diagnostic (Clause 01a172cc-e51b-78a2-b96b-d7788a02a823)". https://github.com/DevilTea/uiux/blob/33bca1f/tests/flow-evidence.test.ts#L185
  # Status: built as of 33bca1f.
  @spec:id:01a172d3-f475-7e47-aac2-cf624136ab20
  @spec:demonstrates:01a11544-62c8-7d37-933b-b991fed72e30
  @spec:demonstrates:01a172cc-e51b-78a2-b96b-d7788a02a823
  Scenario: A Handoff readiness assessment is blocked by a Flow reference diagnostic
    Given a UX Flow whose step names a Variant its View does not have
    When an Agent assesses the readiness of a Handoff rooted at the Flow
    Then a blocking diagnostic names the missing Variant at the step under the Flow
