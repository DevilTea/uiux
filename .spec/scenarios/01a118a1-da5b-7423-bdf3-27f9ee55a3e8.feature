Feature: Static publication
  # Source: spec import batch 8 (Scenarios), priority P2. The demonstrated Rules and Clauses rest on owner rulings or code; see their owners' Rule sources.
  # Test: code@a021f9e `scripts/smoke-publication.mjs#L109` (smoke check "exposed authoring button"). https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/scripts/smoke-publication.mjs#L109
  # Test: code@a021f9e `scripts/smoke-publication.mjs#L184` (smoke check "exposed the canvas Comment button"). https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/scripts/smoke-publication.mjs#L184
  # Test: code@a021f9e `scripts/smoke-publication.mjs#L240` (smoke check "exposed Evidence capture or Handoff export"). https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/scripts/smoke-publication.mjs#L240
  # Status: built as of a021f9e.
  @spec:id:01a118a1-da5b-7878-b6f6-a9273dd043b7
  @spec:demonstrates:01a11485-f27f-7224-a85f-989e56f91f41
  Scenario: The published site offers no authoring
    Given a Workspace published with `uiux publish`
    When a reader opens a View in the published site
    Then no authoring, comment, capture or export control is offered
    Then switching the View's context and the Preview still work
