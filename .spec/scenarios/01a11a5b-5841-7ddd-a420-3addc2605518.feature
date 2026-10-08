Feature: Widget navigation and highlight
  # Source: Discussion #131 (Part 13, Preview protocol additions). Decisions behind the demonstrated Rules and Clauses: #131 body: decision 4 https://github.com/DevilTea/uiux/discussions/131; #131 owner acceptance 2026-10-08 https://github.com/DevilTea/uiux/discussions/131#discussioncomment-18807266.
  # Note: No test exists yet; tests are part of the implementation tracked in issue #105.
  # Status: not built as of cf3b984; see the Implementation gaps entry of 01a11a59-ea08-74ff-8a88-6e70b4fa3a84 in its owner.
  @spec:id:01a11a5b-5841-7f1d-9c16-6d05a3c10c3f
  @spec:demonstrates:01a11a59-ea08-74ff-8a88-6e70b4fa3a84
  Scenario: A highlight restored after comment mode never scrolls the Preview
    Given the Preview runtime declares reveal support
    Given comment mode suspends the Checks highlight of a Widget
    Given the Reviewer has scrolled the Preview until that Widget left the viewport
    When the Reviewer leaves comment mode
    Then the Preview does not scroll
    Then the Widget stays selected
