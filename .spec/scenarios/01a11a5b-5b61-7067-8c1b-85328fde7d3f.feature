Feature: Visible Widget geometry
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 decision 5 https://github.com/DevilTea/uiux/discussions/131#5-region-status-carrier-group-b-106; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Note: No test exists yet; tests are part of the implementation tracked in issue #106.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11658-29fd-7a44-8e90-4da7cfe3d819 in its owner.
  @spec:id:01a11a5b-5b60-7408-8a7b-acb621f9bd5e
  @spec:demonstrates:01a11658-29fd-7a44-8e90-4da7cfe3d819
  Scenario: A change of coverage alone is reported as a new revision
    Given a Widget's geometry stream reports translucent coverage over it
    When the translucent overlay is removed without moving or resizing the Widget
    Then the stream reports the Widget again with an advanced revision and no region status
    Then the Workbench removes the translucent-obstruction notice
