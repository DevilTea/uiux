Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 decision 3 https://github.com/DevilTea/uiux/discussions/131#3-what-the-runtime-does-on-a-reveal-group-a; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Note: No test exists yet; tests are part of the implementation tracked in issue #105.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a59-da48-7437-bee8-67787175cbda in its owner.
  @spec:id:01a11a5b-551e-73f3-8393-a83fb44d7c08
  @spec:demonstrates:01a11a59-da48-7437-bee8-67787175cbda
  Scenario: A hidden navigation target never scrolls the Preview
    Given a Widget hidden by `visibility: hidden` lies below the visible part of the Preview
    Given the Preview runtime declares reveal support
    When a Reviewer opens that Widget from Checks
    Then the Preview does not scroll
    Then the Workbench keeps the Widget selected and draws no highlight
