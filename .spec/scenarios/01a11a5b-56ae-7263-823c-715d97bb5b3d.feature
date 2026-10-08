Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 4 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Note: No test exists yet; tests are part of the implementation tracked in issue #105.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a59-e876-780b-832c-0a139baabc95 in its owner.
  @spec:id:01a11a5b-56ae-70a0-8cd3-0904a173ab4d
  @spec:demonstrates:01a11a59-e876-780b-832c-0a139baabc95
  Scenario: A navigation queued during comment mode reveals its target after comment mode ends
    Given comment mode is active on a View page whose Preview runtime declares reveal support
    Given a Widget of that View is scrolled out of the Preview viewport
    When a Reviewer opens that Widget from the View page's Checks panel
    When the Reviewer leaves comment mode
    Then the Preview scrolls the Widget into view only after comment mode ends
    Then the Workbench highlights the Widget
