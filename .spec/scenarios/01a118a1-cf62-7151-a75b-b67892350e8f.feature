Feature: Workbench authoring
  # Source: spec import batch 8 (Scenarios), priority P1. Decisions behind the demonstrated Rules and Clauses: #1 c171 https://github.com/DevilTea/uiux/discussions/1#discussioncomment-18676070; #1 body: Canonical Decision Index item 9 https://github.com/DevilTea/uiux/discussions/1; #10 c3 https://github.com/DevilTea/uiux/discussions/10#discussioncomment-18676515.
  # Test: code@a021f9e `tests/workbench-authoring-pages.test.ts#L101` "requires the reference-impact acknowledgement before renaming a registry key". https://github.com/DevilTea/uiux/blob/a021f9e1dc892ef7a5845683a228a999c3d5f827/tests/workbench-authoring-pages.test.ts#L101
  # Test: code@257b3c5 `tests/reference-impact-browser.test.ts#L153` "lists the threads that name the key and saves only after "Save anyway"". https://github.com/DevilTea/uiux/blob/257b3c528935a5d6e2d09f01cc938db160381b8a/tests/reference-impact-browser.test.ts#L153
  # Status: built as of 257b3c5.
  # Note: The Settings page asks twice: the registry dialog (`app/components/workspace/RegistryKeyModal.vue`, since d72ec3b) acknowledges the draft change, and the save lists the impact the server returns (`impact_acknowledgement_required`, Rule 01a172ce-2e97-7d83-b175-f0d15f846768) before it is resent with `acknowledgeImpact`.
  @spec:id:01a118a1-cf62-7dc1-9ab5-4afd79e576f0
  @spec:demonstrates:01a1144e-50dd-7b92-aa5e-e175e34bf424
  Scenario: Renaming a viewport key needs an acknowledged reference impact
    Given formal Evidence was captured with the desktop viewport
    When an Editor renames the desktop viewport key in Workspace Settings
    Then the Workbench lists the references the rename affects
    Then the rename is offered only after the Editor acknowledges them
