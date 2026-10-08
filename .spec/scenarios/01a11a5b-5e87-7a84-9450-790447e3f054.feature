Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 4 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Note: No test exists yet; tests are part of the implementation tracked in issue #105.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a59-eba4-7d32-a10e-1241b5337460 in its owner.
  # Note: The Inspector already has the "outside the visible area" copy, but the Workbench reads an empty region set first and shows "not visible" (code@cf3b984 `app/composables/usePreviewSession.ts#L387-L391`); found by reading the code, not reproduced in a browser.
  @spec:id:01a11a5b-5e86-760f-be95-353cfa1da3ab
  @spec:demonstrates:01a11a59-d8be-78aa-bdc7-28aa62bd9444
  @spec:demonstrates:01a11a59-eba4-7d32-a10e-1241b5337460
  Scenario: Without reveal support an offscreen navigation target is shown outside the visible area
    Given the Preview runtime declares none of the reveal, region-status and failure-report features
    Given a rendered Widget lies wholly below the Preview viewport
    When a Reviewer opens that Widget from Checks
    Then the Workbench sends no reveal and the Preview does not scroll
    Then the Workbench keeps the Widget selected and says that it is outside the visible area
