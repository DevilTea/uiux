Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 4 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Status: built as of a5f586e (issue #105, https://github.com/DevilTea/uiux/pull/362): the View page's Checks panel selects with a reveal request (`app/components/readiness/ReadinessTab.vue`, `followFinding`), and a request waits through comment mode (`app/composables/usePreviewSession.ts`, `sendPendingReveal`).
  # Note: No test exists for this path: the View page's Checks panel lists only the findings of a View that cannot render (a View with a validation finding shows "This View cannot be rendered"), so no browser test can follow a finding there to a rendered Widget, and the comment-mode queue lives in the Preview session composable, which no unit test constructs. Overview > Checks, the other Checks navigation, is tested in tests/geometry-reveal-browser.test.ts.
  @spec:id:01a11a5b-56ae-70a0-8cd3-0904a173ab4d
  @spec:demonstrates:01a11a59-e876-780b-832c-0a139baabc95
  Scenario: A navigation queued during comment mode reveals its target after comment mode ends
    Given comment mode is active on a View page whose Preview runtime declares reveal support
    Given a Widget of that View is scrolled out of the Preview viewport
    When a Reviewer opens that Widget from the View page's Checks panel
    When the Reviewer leaves comment mode
    Then the Preview scrolls the Widget into view only after comment mode ends
    Then the Workbench highlights the Widget
