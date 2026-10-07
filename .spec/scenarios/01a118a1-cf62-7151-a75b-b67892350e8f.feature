Feature: Workbench authoring
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c171 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18676070; #1 body: Canonical Decision Index item 9 https://github.com/DevilTea/uiux/discussions/1; #10 c3 https://github.com/DevilTea/uiux/discussions/10#discussioncomment-18676515.
  # Test: code@a021f9e `tests/workbench-authoring-pages.test.ts#L101` "requires the reference-impact acknowledgement before renaming a registry key". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workbench-authoring-pages.test.ts#L101
  # Status: partly built as of a021f9e; see the Implementation gaps entry of 01a1144e-50dd-7b92-aa5e-e175e34bf424 in its owner.
  # Note: Only the Workbench asks, for renaming or removing a viewport or theme key (`app/components/workspace/RegistryKeyModal.vue`, since d72ec3b); MCP and HTTP renames, Variant renames and deletions of Views, UX Flows and Assets run without impact analysis (issue #75). The gap on 01a1144e-50dd-7b92-aa5e-e175e34bf424 says "Not built" and does not mention the Workbench dialog; correcting it to partly built is an owner item of batch 8.
  @spec:id:01a118a1-cf62-7dc1-9ab5-4afd79e576f0
  @spec:demonstrates:01a1144e-50dd-7b92-aa5e-e175e34bf424
  Scenario: Renaming a viewport key needs an acknowledged reference impact
    Given formal Evidence was captured with the desktop viewport
    When an Editor renames the desktop viewport key in Workspace Settings
    Then the Workbench lists the references the rename affects
    Then the rename is offered only after the Editor acknowledges them
